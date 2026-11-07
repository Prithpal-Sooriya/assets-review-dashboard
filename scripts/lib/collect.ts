/**
 * Collection engine: walks each repo's PRs ordered by updated_at (desc)
 * via the REST API and buckets them into per repo-month partitions
 * (data/raw/<repo-slug>/<YYYY-MM>.json) with full review history per PR.
 *
 * Completeness model (why this is a complete walk, not a search):
 *   - Review submissions update the PR's updated_at (validated empirically
 *     over 1071 sampled PRs and cross-checked with reviewed-by search),
 *     so every PR that received any in-window review activity has
 *     updated_at inside the window and is therefore visited by the walk.
 *   - A partition month M is closed only after the walk has descended
 *     strictly below the end of M, i.e. all PRs whose updated_at fell in
 *     M (at collection time) have been visited.
 *
 * Resumability: per-repo walk state is persisted after every listing page;
 * an interrupted run resumes the walk without re-fetching reviews for PRs
 * already captured. Partitions are published atomically only when complete.
 */
import type {
  CollectorConfig,
  Manifest,
  PartitionStatus,
  RawPartition,
  RawPrRecord,
  RawReview,
  WalkState,
} from "./types";
import {
  assertMonth,
  loginSetLower,
  monthOf,
  monthRange,
  partitionKey,
  repoSlug,
  startOfMonthIso,
} from "./config";
import type { RestTransport, RateInfo } from "./gh";
import { RateLimitedError } from "./gh";

// ============================================================================
// Storage abstraction (disk implementation below; in-memory for tests)
// ============================================================================

export interface Store {
  readManifest(): Promise<Manifest | null>;
  writeManifest(manifest: Manifest): Promise<void>;
  writePartition(partition: RawPartition): Promise<void>;
  readWalkState(repo: string): Promise<WalkState | null>;
  writeWalkState(state: WalkState): Promise<void>;
  clearWalkState(repo: string): Promise<void>;
  /** Best-effort single-writer guard. Returns a release function. */
  acquireLock(): Promise<() => void>;
}

export interface CollectDeps {
  transport: RestTransport;
  store: Store;
  now(): Date;
  log: (msg: string) => void;
}

export interface CollectOptions {
  fromMonth: string;
  toMonth?: string;
  repos?: string[];
}

export interface RepoCollectResult {
  repo: string;
  wantedMonths: string[];
  closedMonths: string[];
  stopped: "done" | "rate";
  prsFetched: number;
  reviewRequests: number;
}

export interface CollectReport {
  results: RepoCollectResult[];
  stopped: "done" | "rate";
  /** Months still pending after this run (repo|month keys). */
  pending: string[];
}

// ============================================================================
// REST shapes (subset of fields we consume; everything else is discarded)
// ============================================================================

interface RestPull {
  number: number;
  title: string;
  html_url: string;
  state: string; // "open" | "closed"
  draft?: boolean;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  user: { login: string } | null;
  labels?: { name?: string }[];
}

interface RestReview {
  id: number;
  state: string;
  submitted_at: string | null;
  user: { login: string } | null;
}

// ============================================================================
// Engine
// ============================================================================

interface OpenMonth {
  month: string;
  bucket: Record<number, RawPrRecord>;
}

function prState(p: RestPull): RawPrRecord["state"] {
  if (p.state === "open") return "OPEN";
  return p.merged_at ? "MERGED" : "CLOSED";
}

function toRecord(p: RestPull, rosterReviews: RawReview[]): RawPrRecord {
  return {
    number: p.number,
    title: p.title,
    url: p.html_url,
    state: prState(p),
    draft: !!p.draft,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    closedAt: p.closed_at,
    mergedAt: p.merged_at,
    authorLogin: p.user?.login ?? null,
    labels: (p.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
    reviews: rosterReviews.sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "")),
  };
}

export async function collectPartitions(
  cfg: CollectorConfig,
  deps: CollectDeps,
  opts: CollectOptions,
): Promise<CollectReport> {
  assertMonth(opts.fromMonth, "fromMonth");
  const nowIso = deps.now().toISOString();
  const currentMonth = monthOf(nowIso);
  const toMonth = assertMonth(opts.toMonth ?? currentMonth, "toMonth");
  if (toMonth > currentMonth) throw new Error(`toMonth ${toMonth} is in the future (current month ${currentMonth})`);
  if (opts.fromMonth > toMonth) throw new Error(`fromMonth ${opts.fromMonth} is after toMonth ${toMonth}`);

  const repos = (opts.repos ?? cfg.repos).slice();
  const rosterLc = loginSetLower(cfg.roster);
  const perPage = cfg.request.perPage;
  const rateReserve = cfg.request.rateReserve;
  const rateEvery = Math.max(1, cfg.request.rateCheckInterval);

  const release = await deps.store.acquireLock();
  try {
    const manifest = (await deps.store.readManifest()) ?? { schemaVersion: 1, partitions: {} };
    const results: RepoCollectResult[] = [];
    let budgetStop = false;
    let requestCounter = 0;

    const checkRate = async (): Promise<boolean> => {
      requestCounter++;
      if (requestCounter % rateEvery !== 0) return true;
      const rate = await deps.transport.getRate();
      if (rate.remaining < rateReserve) {
        deps.log(
          `rate budget low: ${rate.remaining}/${rate.limit} remaining (reserve ${rateReserve}); stopping gracefully. Resets at epoch ${rate.resetEpoch}.`,
        );
        return false;
      }
      return true;
    };

    for (const repo of repos) {
      if (budgetStop) {
        results.push({ repo, wantedMonths: [], closedMonths: [], stopped: "rate", prsFetched: 0, reviewRequests: 0 });
        continue;
      }
      const result = await collectRepo({
        repo,
        cfg,
        deps,
        manifest,
        fromMonth: opts.fromMonth,
        toMonth,
        currentMonth,
        rosterLc,
        perPage,
        checkRate,
        markBudgetStop: () => {
          budgetStop = true;
        },
      });
      results.push(result);
      if (result.stopped === "rate") budgetStop = true;
    }

    const pending: string[] = [];
    for (const repo of repos) {
      for (const m of monthRange(opts.fromMonth, toMonth)) {
        const st = manifest.partitions[partitionKey(repo, m)];
        if (!st || st.status !== "complete") pending.push(partitionKey(repo, m));
      }
    }

    return { results, stopped: budgetStop ? "rate" : "done", pending };
  } finally {
    release();
  }
}

interface CollectRepoArgs {
  repo: string;
  cfg: CollectorConfig;
  deps: CollectDeps;
  manifest: Manifest;
  fromMonth: string;
  toMonth: string;
  currentMonth: string;
  rosterLc: Set<string>;
  perPage: number;
  checkRate: () => Promise<boolean>;
  markBudgetStop: () => void;
}

async function collectRepo(args: CollectRepoArgs): Promise<RepoCollectResult> {
  const { repo, cfg, deps, manifest, fromMonth, toMonth, currentMonth, rosterLc, perPage, checkRate } = args;

  // Determine wanted months for this run.
  const targetMonths = monthRange(fromMonth, toMonth);
  const monthEndComplete = new Set(
    targetMonths.filter((m) => {
      const st = manifest.partitions[partitionKey(repo, m)];
      return st?.status === "complete" && st.completeness === "monthEnd";
    }),
  );
  const wantedMonths = targetMonths.filter((m) => {
    if (m === currentMonth) return true; // current partial month is always refreshed
    return !monthEndComplete.has(m);
  });
  if (wantedMonths.length === 0) {
    deps.log(`[${repo}] all target months already month-end complete; skipping.`);
    return { repo, wantedMonths: [], closedMonths: [], stopped: "done", prsFetched: 0, reviewRequests: 0 };
  }
  const wantedSet = new Set(wantedMonths);
  const floorIso = startOfMonthIso(fromMonth);

  // Resume any in-progress walk for this repo (same floor).
  const saved = await deps.store.readWalkState(repo);
  let state: WalkState;
  if (saved && saved.floorMonth === fromMonth) {
    state = saved;
    // The current month is always refreshed to a newer cutoff on re-run:
    // if a previous (interrupted) walk already closed it, re-open it.
    if (state.closedMonths.includes(currentMonth)) {
      state.closedMonths = state.closedMonths.filter((m) => m !== currentMonth);
      delete state.buckets[currentMonth];
      deps.log(`[${repo}] re-opening current month ${currentMonth} for refresh.`);
    }
    deps.log(`[${repo}] resuming walk: ${saved.closedMonths.length} months closed, ${Object.values(saved.buckets).reduce((a, b) => a + Object.keys(b).length, 0)} PRs cached.`);
  } else {
    state = { repo, floorMonth: fromMonth, closedMonths: [], buckets: {} };
  }

  const closedThisRun = new Set<string>();
  const openMonths: OpenMonth[] = [];
  for (const m of wantedMonths) {
    if (state.closedMonths.includes(m)) {
      closedThisRun.add(m);
      continue;
    }
    openMonths.push({ month: m, bucket: state.buckets[m] ?? {} });
    state.buckets[m] = openMonths[openMonths.length - 1]!.bucket;
  }

  const walkStartedIso = deps.now().toISOString(); // honest cutoff for asOfCutoff partitions
  let prsFetched = 0;
  let reviewRequests = 0;
  let page = 1;

  const closeMonth = async (om: OpenMonth): Promise<void> => {
    const completeness: RawPartition["completeness"] =
      om.month === currentMonth ? "asOfCutoff" : "monthEnd";
    const prs = Object.values(om.bucket)
      .filter((r) => monthOf(r.updatedAt) === om.month)
      .sort((a, b) => a.number - b.number);
    const partition: RawPartition = {
      schemaVersion: 1,
      repo,
      month: om.month,
      completeness,
      collectedAt: walkStartedIso,
      prCount: prs.length,
      prs,
    };
    await deps.store.writePartition(partition);
    manifest.partitions[partitionKey(repo, om.month)] = {
      status: "complete",
      completeness,
      collectedAt: walkStartedIso,
      prCount: prs.length,
    };
    await deps.store.writeManifest(manifest);
    state.closedMonths.push(om.month);
    delete state.buckets[om.month];
    closedThisRun.add(om.month);
    deps.log(`[${repo}] closed ${om.month} (${completeness}): ${prs.length} PRs.`);
  };

  const closeAllOpen = async (): Promise<void> => {
    while (openMonths.length > 0) {
      const om = openMonths.pop()!; // newest first
      await closeMonth(om);
    }
    await deps.store.clearWalkState(repo);
  };

  const fetchRosterReviews = async (number: number): Promise<RawReview[]> => {
    const all: RawReview[] = [];
    for (let rp = 1; ; rp++) {
      reviewRequests++;
      if (!(await checkRate())) throw new BudgetStop();
      const batch = (await deps.transport.getJson(
        `/repos/${repo}/pulls/${number}/reviews?per_page=${perPage}&page=${rp}`,
      )) as RestReview[];
      if (!Array.isArray(batch)) throw new Error(`reviews for ${repo}#${number}: unexpected response`);
      for (const r of batch) {
        const login = r.user?.login;
        if (login && rosterLc.has(login.toLowerCase())) {
          all.push({ id: r.id, state: r.state, submittedAt: r.submitted_at, authorLogin: login });
        }
      }
      if (batch.length < perPage) break;
    }
    return all;
  };

  let budgetStopped = false;

  try {
    walk: for (;;) {
      if (!(await checkRate())) {
        args.markBudgetStop();
        budgetStopped = true;
        break;
      }
      const pageJson = await deps.transport.getJson(
        `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
      );
      if (!Array.isArray(pageJson)) throw new Error(`pulls page ${page} for ${repo}: unexpected response`);
      const prs = pageJson as RestPull[];
      if (prs.length === 0) {
        await closeAllOpen();
        break;
      }

      for (const pr of prs) {
        const updatedAt = pr.updated_at;
        if (Date.parse(updatedAt) < Date.parse(floorIso)) {
          await closeAllOpen();
          break walk;
        }
        const m = monthOf(updatedAt);
        // Close every open month whose start is ABOVE this PR's update
        // time — the walk has descended below the month's floor, so every
        // PR belonging to it has already been visited (updated_at is
        // strictly within or above the month). openMonths is ascending,
        // so the newest open month is at the end. The current month closes
        // as asOfCutoff through the walk start time.
        while (
          openMonths.length > 0 &&
          Date.parse(updatedAt) < Date.parse(startOfMonthIso(openMonths[openMonths.length - 1]!.month))
        ) {
          const om = openMonths.pop()!;
          await closeMonth(om);
        }
        if (!wantedSet.has(m)) continue; // out-of-range or already month-end complete
        const om = openMonths.find((o) => o.month === m);
        if (!om) continue; // wanted month already closed earlier in this walk
        if (om.bucket[pr.number]) continue; // already captured (resume cache)
        const reviews = await fetchRosterReviews(pr.number);
        prsFetched++;
        om.bucket[pr.number] = toRecord(pr, reviews);
      }

      page++;
      await deps.store.writeWalkState(state); // durable page-level checkpoint
    }
  } catch (e) {
    if (e instanceof BudgetStop || e instanceof RateLimitedError) {
      args.markBudgetStop();
      budgetStopped = true;
    } else {
      throw e;
    }
  }

  if (budgetStopped && openMonths.length > 0) {
    // Graceful rate stop: persist state, mark open wanted months pending.
    for (const om of openMonths) {
      manifest.partitions[partitionKey(repo, om.month)] = {
        status: "pending",
        detail: "run stopped at rate budget reserve; re-run to resume",
      };
    }
    await deps.store.writeWalkState(state);
    await deps.store.writeManifest(manifest);
  }

  return {
    repo,
    wantedMonths,
    closedMonths: [...closedThisRun],
    stopped: openMonths.length > 0 ? "rate" : "done",
    prsFetched,
    reviewRequests,
  };
}

/** Internal control-flow signal for graceful budget stops. */
class BudgetStop extends Error {}
