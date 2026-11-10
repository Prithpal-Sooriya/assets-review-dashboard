/**
 * Deterministic aggregation: raw repo-month partitions + manifest -> the
 * exact dashboard contract (DashboardData). Pure function of its inputs
 * (config, asOf, manifest, partitions); no clock, no network, no randomness.
 *
 * Semantics (see docs/collection.md for the full methodology):
 *  - Review months come from review submittedAt (UTC), never mergedAt.
 *  - Qualifying review: roster member, not the PR author, state in
 *    reviewStates (APPROVED/CHANGES_REQUESTED/COMMENTED/DISMISSED),
 *    submitted. PENDING and non-roster reviews (incl. excluded reviewers)
 *    never qualify.
 *  - Ownership: team-assets label => internal/team-label; else roster
 *    author => internal/team-author; else external/other.
 *  - A freshest-snapshot rule resolves a PR appearing in several
 *    partitions (its updated_at month moved after a later collection):
 *    the record from the partition with the newest collectedAt wins.
 *  - A month row is emitted for a repo only when partitions for that repo
 *    are complete from the month through the current month (a PR reviewed
 *    in month M may live in any later partition because later activity
 *    moves its updated_at).
 */
import {
  ALL_REPOS,
  type ActivityCounts,
  type CollectorConfig,
  type CoverageEntry,
  type DashboardData,
  type FirstReviewSample,
  type Manifest,
  type MonthRow,
  type PrEntry,
  type RawPartition,
  type RawPrRecord,
  type RawReview,
  type ReviewerMonthRow,
  type TeamMergeSample,
  type TrendMonthRow,
  type WeekRow,
} from "./types";
import { changedLines, parseDiffSize, sizeBucket } from "./diff-size";
import {
  addMonths,
  isoWeekKey,
  loginSetLower,
  monthOf,
  monthRange,
  partitionKey,
  startOfIsoWeekMs,
  startOfMonthIso,
} from "./config";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Manifest-complete partitions in the display window must have their raw
 * data files present. A missing file means a silently dropped month on the
 * dashboard — e.g. a hand deletion of a collector-owned file on main that
 * propagated through the data branch. The aggregate fails loudly on these
 * (recovery: docs/collection.md "Data branch repair").
 */
export async function findMissingCompletePartitions(
  manifest: Manifest,
  repos: string[],
  months: string[],
  hasFile: (repo: string, month: string) => Promise<boolean>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const repo of repos) {
    for (const m of months) {
      if (manifest.partitions[`${repo}|${m}`]?.status === "complete" && !(await hasFile(repo, m))) {
        missing.push(`${repo}|${m}`);
      }
    }
  }
  return missing;
}

export interface AggregateInput {
  config: CollectorConfig;
  /** ISO UTC instant: generatedAt, the range end bound, and the partition
   *  inclusion guard (partitions collected after it are ignored). Per-record
   *  review cutoffs are each partition's own collectedAt — the honest
   *  observability bound for that snapshot — not this value. */
  asOf: string;
  manifest: Manifest;
  partitions: RawPartition[];
}

interface ResolvedPr {
  record: RawPrRecord;
  repo: string;
  partitionCollectedAt: string;
}

function ownershipOf(cfg: CollectorConfig, record: RawPrRecord): PrEntry["ownershipReason"] {
  const teamLabelLc = cfg.teamLabel.toLowerCase();
  if (record.labels.some((l) => l.toLowerCase() === teamLabelLc)) return "team-label";
  if (record.authorLogin && loginSetLowerCached(cfg).has(record.authorLogin.toLowerCase())) return "team-author";
  return "other";
}

let rosterCache = new WeakMap<CollectorConfig, Set<string>>();
function loginSetLowerCached(cfg: CollectorConfig): Set<string> {
  let set = rosterCache.get(cfg);
  if (!set) {
    set = loginSetLower(cfg.roster);
    rosterCache.set(cfg, set);
  }
  return set;
}

function isInternal(cfg: CollectorConfig, record: RawPrRecord): boolean {
  const reason = ownershipOf(cfg, record);
  return reason === "team-label" || reason === "team-author";
}

/** Qualifying review events for a record (all months, incl. pre-window evidence).
 *  Reviews submitted at/after the record's partition cutoff (that walk's
 *  start) are defensively excluded: a partition only guarantees capture of
 *  events strictly before its own cutoff, so counts are exact for it. */
function qualifyingReviews(cfg: CollectorConfig, record: RawPrRecord, cutoffMs: number): RawReview[] {
  const states = new Set(cfg.reviewStates);
  const roster = loginSetLowerCached(cfg);
  const authorLc = record.authorLogin?.toLowerCase();
  return record.reviews.filter((r) => {
    if (!r.submittedAt) return false; // PENDING or missing
    if (!states.has(r.state)) return false; // e.g. PENDING
    if (!roster.has(r.authorLogin.toLowerCase())) return false; // non-roster / excluded
    if (authorLc && r.authorLogin.toLowerCase() === authorLc) return false; // self-review
    if (Date.parse(r.submittedAt) >= cutoffMs) return false; // at/after partition cutoff
    return true;
  });
}

interface ReviewerAcc {
  reviewSubmissions: number;
  reviewedPrs: number;
  approvals: number;
  changesRequested: number;
  comments: number;
  dismissed: number;
}

interface MonthStats {
  internalReviewedPrs: number;
  externalReviewedPrs: number;
  reviewSubmissions: number;
  reviewedUnmergedPrs: number;
  mergedInternalPrs: number;
  mergedExternalReviewedPrs: number;
  reviewers: Map<string, ReviewerAcc>;
  multiReviewerPrs: number;
  firstReviewMinutes: number[];
  reviewedMerges: number;
  reviewToMergeMinutes: number[];
  changedLines: number[];
  changedFiles: number[];
  sizeSmall: number;
  sizeMedium: number;
  sizeLarge: number;
  sizeXLarge: number;
}

function emptyAcc(): ReviewerAcc {
  return {
    reviewSubmissions: 0,
    reviewedPrs: 0,
    approvals: 0,
    changesRequested: 0,
    comments: 0,
    dismissed: 0,
  };
}

function rosterOrder(cfg: CollectorConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const login of cfg.roster) {
    const lc = login.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    out.push(login);
  }
  return out;
}

function canonicalLogin(roster: string[], login: string): string | null {
  const lc = login.toLowerCase();
  return roster.find((name) => name.toLowerCase() === lc) ?? null;
}

/** Median, rounding a tie of the two middle values to the nearest integer. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function bumpState(acc: ReviewerAcc, state: string): void {
  if (state === "APPROVED") acc.approvals++;
  else if (state === "CHANGES_REQUESTED") acc.changesRequested++;
  else if (state === "COMMENTED") acc.comments++;
  else if (state === "DISMISSED") acc.dismissed++;
}

/**
 * Month counters for one repo. Same qualifying-review rules as the
 * historical month row, plus per-person attribution, pace samples, and
 * diff-size samples. Pace uses the earliest qualifying review on the
 * freshest snapshot (including reviews submitted before the window).
 */
function measureMonth(
  cfg: CollectorConfig,
  roster: string[],
  resolved: ResolvedPr[],
  month: string,
  asOfMs: number,
): MonthStats {
  const monthStartMs = Date.parse(startOfMonthIso(month));
  const monthEndMs = Date.parse(startOfMonthIso(addMonths(month, 1)));
  const reviewers = new Map<string, ReviewerAcc>();
  for (const login of roster) reviewers.set(login, emptyAcc());
  const stats: MonthStats = {
    internalReviewedPrs: 0,
    externalReviewedPrs: 0,
    reviewSubmissions: 0,
    reviewedUnmergedPrs: 0,
    mergedInternalPrs: 0,
    mergedExternalReviewedPrs: 0,
    reviewers,
    multiReviewerPrs: 0,
    firstReviewMinutes: [],
    reviewedMerges: 0,
    reviewToMergeMinutes: [],
    changedLines: [],
    changedFiles: [],
    sizeSmall: 0,
    sizeMedium: 0,
    sizeLarge: 0,
    sizeXLarge: 0,
  };

  for (const rp of resolved) {
    const record = rp.record;
    const cutoffMs = Date.parse(rp.partitionCollectedAt);
    const qReviews = qualifyingReviews(cfg, record, cutoffMs);
    const inMonth = qReviews.filter((r) => {
      const t = Date.parse(r.submittedAt!);
      return t >= monthStartMs && t < monthEndMs && t < asOfMs;
    });
    if (inMonth.length > 0) {
      const internal = isInternal(cfg, record);
      if (internal) stats.internalReviewedPrs++;
      else stats.externalReviewedPrs++;
      stats.reviewSubmissions += inMonth.length;
      if (record.state !== "MERGED") stats.reviewedUnmergedPrs++;

      const distinct = new Set<string>();
      const seenPr = new Set<string>();
      for (const r of inMonth) {
        const login = canonicalLogin(roster, r.authorLogin);
        if (!login) continue;
        distinct.add(login);
        const acc = reviewers.get(login)!;
        acc.reviewSubmissions++;
        const prKey = `${login}#${record.number}`;
        if (!seenPr.has(prKey)) {
          seenPr.add(prKey);
          acc.reviewedPrs++;
        }
        bumpState(acc, r.state);
      }
      if (distinct.size >= 2) stats.multiReviewerPrs++;

      const size = parseDiffSize(record);
      if (size) {
        const lines = changedLines(size);
        stats.changedLines.push(lines);
        stats.changedFiles.push(size.changedFiles);
        const bucket = sizeBucket(lines);
        if (bucket === "small") stats.sizeSmall++;
        else if (bucket === "medium") stats.sizeMedium++;
        else if (bucket === "large") stats.sizeLarge++;
        else stats.sizeXLarge++;
      }
    }
    if (record.mergedAt !== null) {
      const mergedMs = Date.parse(record.mergedAt);
      const mergedInMonth = mergedMs >= monthStartMs && mergedMs < monthEndMs && mergedMs < asOfMs;
      if (mergedInMonth) {
        if (isInternal(cfg, record)) {
          stats.mergedInternalPrs++;
        } else if (qReviews.some((r) => Date.parse(r.submittedAt!) <= mergedMs)) {
          stats.mergedExternalReviewedPrs++;
        }
        const prior = qReviews.filter((r) => Date.parse(r.submittedAt!) <= mergedMs);
        if (prior.length > 0) {
          let firstMs = Infinity;
          for (const r of prior) firstMs = Math.min(firstMs, Date.parse(r.submittedAt!));
          if (Number.isFinite(firstMs) && mergedMs >= firstMs) {
            stats.reviewedMerges++;
            stats.reviewToMergeMinutes.push(Math.round((mergedMs - firstMs) / 60000));
          }
        }
      }
    }
    if (qReviews.length > 0) {
      let firstMs = Infinity;
      for (const r of qReviews) firstMs = Math.min(firstMs, Date.parse(r.submittedAt!));
      const createdMs = Date.parse(record.createdAt);
      if (
        firstMs >= monthStartMs &&
        firstMs < monthEndMs &&
        firstMs < asOfMs &&
        Number.isFinite(createdMs) &&
        firstMs >= createdMs
      ) {
        stats.firstReviewMinutes.push(Math.round((firstMs - createdMs) / 60000));
      }
    }
  }
  return stats;
}

function outcomeTotals(stats: MonthStats): Pick<TrendMonthRow, "approvals" | "changesRequested" | "comments" | "dismissed"> {
  let approvals = 0;
  let changesRequested = 0;
  let comments = 0;
  let dismissed = 0;
  for (const acc of stats.reviewers.values()) {
    approvals += acc.approvals;
    changesRequested += acc.changesRequested;
    comments += acc.comments;
    dismissed += acc.dismissed;
  }
  return { approvals, changesRequested, comments, dismissed };
}

function toTrendRow(month: string, repo: string, stats: MonthStats): TrendMonthRow {
  return {
    month,
    repo,
    ...outcomeTotals(stats),
    reviewedPrs: stats.internalReviewedPrs + stats.externalReviewedPrs,
    multiReviewerPrs: stats.multiReviewerPrs,
    firstReviews: stats.firstReviewMinutes.length,
    medianMinutesToFirstReview: median(stats.firstReviewMinutes),
    reviewedMerges: stats.reviewedMerges,
    medianMinutesReviewToMerge: median(stats.reviewToMergeMinutes),
    sizedReviewedPrs: stats.changedLines.length,
    medianChangedLines: median(stats.changedLines),
    medianChangedFiles: median(stats.changedFiles),
    sizeSmall: stats.sizeSmall,
    sizeMedium: stats.sizeMedium,
    sizeLarge: stats.sizeLarge,
    sizeXLarge: stats.sizeXLarge,
  };
}

function reviewerRowsFor(month: string, repo: string, roster: string[], stats: MonthStats): ReviewerMonthRow[] {
  return roster.map((login) => {
    const acc = stats.reviewers.get(login) ?? emptyAcc();
    return {
      month,
      repo,
      login,
      reviewSubmissions: acc.reviewSubmissions,
      reviewedPrs: acc.reviewedPrs,
      approvals: acc.approvals,
      changesRequested: acc.changesRequested,
      comments: acc.comments,
      dismissed: acc.dismissed,
    };
  });
}

function emptyStats(roster: string[]): MonthStats {
  const reviewers = new Map<string, ReviewerAcc>();
  for (const login of roster) reviewers.set(login, emptyAcc());
  return {
    internalReviewedPrs: 0,
    externalReviewedPrs: 0,
    reviewSubmissions: 0,
    reviewedUnmergedPrs: 0,
    mergedInternalPrs: 0,
    mergedExternalReviewedPrs: 0,
    reviewers,
    multiReviewerPrs: 0,
    firstReviewMinutes: [],
    reviewedMerges: 0,
    reviewToMergeMinutes: [],
    changedLines: [],
    changedFiles: [],
    sizeSmall: 0,
    sizeMedium: 0,
    sizeLarge: 0,
    sizeXLarge: 0,
  };
}

/** Sum per-repo months. Distinct-PR counts add (numbers collide across repos). Medians are recomputed from the pooled samples. */
function poolStats(roster: string[], parts: MonthStats[]): MonthStats {
  const pooled = emptyStats(roster);
  for (const part of parts) {
    pooled.internalReviewedPrs += part.internalReviewedPrs;
    pooled.externalReviewedPrs += part.externalReviewedPrs;
    pooled.reviewSubmissions += part.reviewSubmissions;
    pooled.reviewedUnmergedPrs += part.reviewedUnmergedPrs;
    pooled.mergedInternalPrs += part.mergedInternalPrs;
    pooled.mergedExternalReviewedPrs += part.mergedExternalReviewedPrs;
    pooled.multiReviewerPrs += part.multiReviewerPrs;
    pooled.reviewedMerges += part.reviewedMerges;
    pooled.sizeSmall += part.sizeSmall;
    pooled.sizeMedium += part.sizeMedium;
    pooled.sizeLarge += part.sizeLarge;
    pooled.sizeXLarge += part.sizeXLarge;
    pooled.firstReviewMinutes.push(...part.firstReviewMinutes);
    pooled.reviewToMergeMinutes.push(...part.reviewToMergeMinutes);
    pooled.changedLines.push(...part.changedLines);
    pooled.changedFiles.push(...part.changedFiles);
    for (const login of roster) {
      const src = part.reviewers.get(login);
      const dest = pooled.reviewers.get(login)!;
      if (!src) continue;
      dest.reviewSubmissions += src.reviewSubmissions;
      dest.reviewedPrs += src.reviewedPrs;
      dest.approvals += src.approvals;
      dest.changesRequested += src.changesRequested;
      dest.comments += src.comments;
      dest.dismissed += src.dismissed;
    }
  }
  return pooled;
}

export function aggregate(input: AggregateInput): DashboardData {
  const { config: cfg, manifest } = input;
  const asOf = input.asOf;
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) throw new Error(`invalid asOf: ${asOf}`);
  const currentMonth = monthOf(asOf);
  const startMonth = addMonths(currentMonth, -cfg.displayWindowMonths);
  const monthsList = monthRange(startMonth, currentMonth);
  const rangeStartIso = startOfMonthIso(startMonth);
  const monthSet = new Set(monthsList);

  // ---- Resolve freshest PR records per repo ------------------------------
  // Only partitions the manifest marks complete are trusted (the engine
  // writes partition file and manifest entry together atomically).
  const loadedKeys = new Set<string>();
  const byRepo = new Map<string, Map<number, ResolvedPr>>();
  for (const p of input.partitions) {
    if (!monthSet.has(p.month)) continue; // defensive: outside window
    if (!cfg.repos.includes(p.repo)) continue;
    if (manifest.partitions[partitionKey(p.repo, p.month)]?.status !== "complete") continue;
    if (Date.parse(p.collectedAt) > asOfMs) continue; // defensive: future data
    loadedKeys.add(partitionKey(p.repo, p.month));
    const map = byRepo.get(p.repo) ?? new Map<number, ResolvedPr>();
    byRepo.set(p.repo, map);
    for (const record of p.prs) {
      const existing = map.get(record.number);
      if (
        !existing ||
        Date.parse(p.collectedAt) > Date.parse(existing.partitionCollectedAt) ||
        (p.collectedAt === existing.partitionCollectedAt &&
          Date.parse(record.updatedAt) > Date.parse(existing.record.updatedAt))
      ) {
        map.set(record.number, { record, repo: p.repo, partitionCollectedAt: p.collectedAt });
      }
    }
  }

  // ---- Build prs[] scope --------------------------------------------------
  const prEntries: PrEntry[] = [];
  const repoRecords = new Map<string, ResolvedPr[]>();
  for (const repo of cfg.repos) {
    const resolved = [...(byRepo.get(repo)?.values() ?? [])].sort((a, b) => a.record.number - b.record.number);
    repoRecords.set(repo, resolved);
    for (const rp of resolved) {
      const record = rp.record;
      // Per-record honest cutoff: the walk start of the partition this
      // snapshot came from (may be earlier than the global asOf when
      // partitions were collected across multiple runs).
      const cutoffMs = Date.parse(rp.partitionCollectedAt);
      const qReviews = qualifyingReviews(cfg, record, cutoffMs);
      const countsByMonth = new Map<string, number>();
      for (const r of qReviews) {
        const m = monthOf(r.submittedAt!);
        countsByMonth.set(m, (countsByMonth.get(m) ?? 0) + 1);
      }
      const reviewMonths = [...countsByMonth.keys()].sort();
      const internal = isInternal(cfg, record);
      const mergedInWindow =
        record.mergedAt !== null &&
        Date.parse(record.mergedAt) >= Date.parse(rangeStartIso) &&
        Date.parse(record.mergedAt) < asOfMs;
      const hasQualifyingInWindow = [...countsByMonth.keys()].some(
        (m) => monthSet.has(m) && Date.parse(startOfMonthIso(m)) >= Date.parse(rangeStartIso),
      );
      const reviewedBeforeMerge =
        record.mergedAt !== null && qReviews.some((r) => Date.parse(r.submittedAt!) <= Date.parse(record.mergedAt!));
      const inScope =
        hasQualifyingInWindow ||
        (internal && mergedInWindow) ||
        (!internal && mergedInWindow && reviewedBeforeMerge);
      if (!inScope) continue;
      prEntries.push({
        id: `${repo}#${record.number}`,
        repo,
        number: record.number,
        title: record.title,
        url: record.url,
        ownership: internal ? "internal" : "external",
        ownershipReason: ownershipOf(cfg, record),
        state: record.state,
        mergedAt: record.mergedAt,
        reviewMonths,
        reviewCountsByMonth: Object.fromEntries(
          reviewMonths.map((m) => [m, countsByMonth.get(m)!]),
        ),
        labels: record.labels,
      });
    }
  }

  // Prepared once per repo so month rows, week rows and timing samples
  // share one definition of "qualifying review" and one cutoff.
  const preparedByRepo = new Map<string, PreparedPr[]>();
  const depsCompleteFor = (repo: string, month: string): boolean =>
    monthRange(month, currentMonth).every((dm) => {
      const key = partitionKey(repo, dm);
      const st = manifest.partitions[key];
      return st?.status === "complete" && loadedKeys.has(key);
    });
  for (const repo of cfg.repos) {
    preparedByRepo.set(
      repo,
      (repoRecords.get(repo) ?? []).map((rp) => preparePr(cfg, rp)),
    );
  }

  // ---- Month rows (dependency-complete months only) -----------------------
  const roster = rosterOrder(cfg);
  const monthRows: MonthRow[] = [];
  const reviewerRows: ReviewerMonthRow[] = [];
  const trendRows: TrendMonthRow[] = [];
  const statsByKey = new Map<string, MonthStats>();
  for (const repo of cfg.repos) {
    const prepared = preparedByRepo.get(repo)!;
    const resolved = repoRecords.get(repo)!;
    for (const m of monthsList) {
      if (!depsCompleteFor(repo, m)) continue;
      const monthStartMs = Date.parse(startOfMonthIso(m));
      const monthEndMs = Math.min(Date.parse(startOfMonthIso(addMonths(m, 1))), asOfMs);
      const counts = countActivity(prepared, monthStartMs, monthEndMs, () => true);
      monthRows.push({ month: m, repo, ...counts });
      const stats = measureMonth(cfg, roster, resolved, m, asOfMs);
      statsByKey.set(`${repo}|${m}`, stats);
      reviewerRows.push(...reviewerRowsFor(m, repo, roster, stats));
      trendRows.push(toTrendRow(m, repo, stats));
    }
  }
  for (const m of monthsList) {
    const parts = cfg.repos
      .map((repo) => statsByKey.get(`${repo}|${m}`))
      .filter((s): s is MonthStats => s !== undefined);
    if (parts.length === 0) continue;
    const pooled = poolStats(roster, parts);
    reviewerRows.push(...reviewerRowsFor(m, ALL_REPOS, roster, pooled));
    trendRows.push(toTrendRow(m, ALL_REPOS, pooled));
  }
  monthRows.sort((a, b) => (a.month === b.month ? a.repo.localeCompare(b.repo) : a.month.localeCompare(b.month)));
  const rowOrder = (a: { month: string; repo: string }, b: { month: string; repo: string }) =>
    a.month === b.month ? a.repo.localeCompare(b.repo) : a.month.localeCompare(b.month);
  reviewerRows.sort((a, b) => {
    const base = rowOrder(a, b);
    if (base !== 0) return base;
    return roster.indexOf(a.login) - roster.indexOf(b.login);
  });
  trendRows.sort(rowOrder);

  // ---- Week rows -----------------------------------------------------------
  // A week is emitted when at least one collection-window month it overlaps
  // is dependency-complete. Events in months that are not complete are left
  // out, and the week is marked partial — so weekly sums of submissions and
  // merges equal the monthly sums for the same repo.
  const rangeStartMs = Date.parse(rangeStartIso);
  const weekRows: WeekRow[] = [];
  const weekSpans = weeksOverlapping(rangeStartMs, asOfMs);
  for (const repo of cfg.repos) {
    const prepared = preparedByRepo.get(repo)!;
    const allow = (month: string) => monthSet.has(month) && depsCompleteFor(repo, month);
    for (const span of weekSpans) {
      const clippedStart = Math.max(span.startMs, rangeStartMs);
      const clippedEnd = Math.min(span.endMs, asOfMs);
      if (clippedStart >= clippedEnd) continue;
      const touched = monthsTouched(span.startMs, span.endMs);
      const overlapsComplete = touched.some((m) => allow(m));
      if (!overlapsComplete) continue;
      const overlapsIncomplete = touched.some((m) => monthSet.has(m) && !depsCompleteFor(repo, m));
      const counts = countActivity(prepared, clippedStart, clippedEnd, allow);
      weekRows.push({
        week: span.week,
        weekStart: new Date(span.startMs).toISOString(),
        repo,
        partial: overlapsIncomplete || span.startMs < rangeStartMs || span.endMs > asOfMs,
        ...counts,
      });
    }
  }
  weekRows.sort((a, b) => (a.week === b.week ? a.repo.localeCompare(b.repo) : a.week.localeCompare(b.week)));

  // ---- Timing samples (no PR identity) ------------------------------------
  const firstReviews: FirstReviewSample[] = [];
  const teamMerges: TeamMergeSample[] = [];
  for (const repo of cfg.repos) {
    for (const pr of preparedByRepo.get(repo)!) {
      const first = pr.qReviews[0];
      if (first && first.at >= rangeStartMs && first.at < asOfMs) {
        const reviewMonth = monthOf(new Date(first.at).toISOString());
        if (depsCompleteFor(repo, reviewMonth)) {
          const minutes = elapsedMinutes(pr.createdAt, first.at);
          if (minutes !== null) {
            firstReviews.push({
              repo,
              ownership: pr.internal ? "internal" : "external",
              at: first.submittedAt,
              minutes,
            });
          }
        }
      }
      if (pr.internal && pr.mergedMs !== null && pr.mergedMs >= rangeStartMs && pr.mergedMs < asOfMs) {
        const mergeMonth = monthOf(new Date(pr.mergedMs).toISOString());
        if (depsCompleteFor(repo, mergeMonth)) {
          const minutes = elapsedMinutes(pr.createdAt, pr.mergedMs);
          if (minutes !== null) {
            teamMerges.push({ repo, mergedAt: pr.mergedAt!, minutes });
          }
        }
      }
    }
  }
  firstReviews.sort(compareFirstReview);
  teamMerges.sort(compareTeamMerge);

  // ---- Coverage ------------------------------------------------------------
  const coverage: CoverageEntry[] = [];
  for (const repo of cfg.repos) {
    for (const m of monthsList) {
      const st = manifest.partitions[partitionKey(repo, m)];
      if (!st) {
        coverage.push({ repo, month: m, status: "pending", detail: "not collected" });
      } else if (st.status === "complete") {
        if (loadedKeys.has(partitionKey(repo, m))) {
          coverage.push({ repo, month: m, status: "complete" });
        } else {
          coverage.push({ repo, month: m, status: "error", detail: "manifest complete but partition file missing" });
        }
      } else if (st.status === "pending") {
        coverage.push({ repo, month: m, status: "pending", detail: st.detail ?? "pending" });
      }
    }
  }
  coverage.sort((a, b) => (a.repo === b.repo ? a.month.localeCompare(b.month) : a.repo.localeCompare(b.repo)));

  prEntries.sort((a, b) => (a.repo === b.repo ? a.number - b.number : a.repo.localeCompare(b.repo)));

  return {
    schemaVersion: 1,
    generatedAt: asOf,
    range: { start: rangeStartIso, end: asOf },
    methodology: { version: cfg.methodologyVersion, notes: cfg.methodologyNotes },
    coverage,
    months: monthRows,
    reviewers: reviewerRows,
    trends: trendRows,
    prs: prEntries,
    weeks: weekRows,
    firstReviews,
    teamMerges,
  };
}

interface PreparedReview {
  at: number;
  submittedAt: string;
}

interface PreparedPr {
  internal: boolean;
  createdAt: string;
  mergedAt: string | null;
  mergedMs: number | null;
  state: RawPrRecord["state"];
  /** Qualifying reviews, earliest first. */
  qReviews: PreparedReview[];
}

function preparePr(cfg: CollectorConfig, rp: ResolvedPr): PreparedPr {
  const cutoffMs = Date.parse(rp.partitionCollectedAt);
  const qReviews = qualifyingReviews(cfg, rp.record, cutoffMs)
    .map((r) => ({ at: Date.parse(r.submittedAt!), submittedAt: r.submittedAt! }))
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at || a.submittedAt.localeCompare(b.submittedAt));
  const mergedMs = rp.record.mergedAt === null ? null : Date.parse(rp.record.mergedAt);
  return {
    internal: isInternal(cfg, rp.record),
    createdAt: rp.record.createdAt,
    mergedAt: rp.record.mergedAt,
    mergedMs: mergedMs !== null && Number.isFinite(mergedMs) ? mergedMs : null,
    state: rp.record.state,
    qReviews,
  };
}

function emptyCounts(): ActivityCounts {
  return {
    internalReviewedPrs: 0,
    externalReviewedPrs: 0,
    reviewSubmissions: 0,
    reviewedUnmergedPrs: 0,
    mergedInternalPrs: 0,
    mergedExternalReviewedPrs: 0,
  };
}

/**
 * Activity whose timestamp falls in [startMs, endMs) AND whose calendar
 * month passes `allowMonth`. One PR counts once per call even if it has
 * several reviews in the interval.
 */
function countActivity(
  prepared: PreparedPr[],
  startMs: number,
  endMs: number,
  allowMonth: (month: string) => boolean,
): ActivityCounts {
  const counts = emptyCounts();
  if (!(startMs < endMs)) return counts;
  const included = (t: number): boolean => {
    if (t < startMs || t >= endMs) return false;
    return allowMonth(monthOf(new Date(t).toISOString()));
  };
  for (const pr of prepared) {
    const inPeriod = pr.qReviews.filter((r) => included(r.at));
    if (inPeriod.length > 0) {
      if (pr.internal) counts.internalReviewedPrs++;
      else counts.externalReviewedPrs++;
      counts.reviewSubmissions += inPeriod.length;
      if (pr.state !== "MERGED") counts.reviewedUnmergedPrs++;
    }
    if (pr.mergedMs !== null && included(pr.mergedMs)) {
      if (pr.internal) {
        counts.mergedInternalPrs++;
      } else if (pr.qReviews.some((r) => r.at <= pr.mergedMs!)) {
        counts.mergedExternalReviewedPrs++;
      }
    }
  }
  return counts;
}

interface WeekSpan {
  week: string;
  startMs: number;
  endMs: number;
}

/** ISO weeks that overlap [rangeStartMs, asOfMs). */
function weeksOverlapping(rangeStartMs: number, asOfMs: number): WeekSpan[] {
  const out: WeekSpan[] = [];
  let startMs = startOfIsoWeekMs(rangeStartMs);
  // Guard against a corrupt range walking forever.
  for (let i = 0; i < 600 && startMs < asOfMs; i++) {
    const endMs = startMs + WEEK_MS;
    out.push({ week: isoWeekKey(startMs), startMs, endMs });
    startMs = endMs;
  }
  return out;
}

/** Calendar months touched by [startMs, endMs), in order. */
function monthsTouched(startMs: number, endMs: number): string[] {
  const out: string[] = [];
  let cursor = startMs;
  for (let i = 0; i < 24 && cursor < endMs; i++) {
    const month = monthOf(new Date(cursor).toISOString());
    out.push(month);
    const next = Date.parse(startOfMonthIso(addMonths(month, 1)));
    if (!(next > cursor)) break;
    cursor = next;
  }
  return out;
}

/** Nearest whole minute. Negative or non-finite spans are dropped. */
function elapsedMinutes(fromIso: string, toMs: number): number | null {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from) || !Number.isFinite(toMs)) return null;
  const minutes = Math.round((toMs - from) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return minutes;
}

function compareFirstReview(a: FirstReviewSample, b: FirstReviewSample): number {
  const dt = Date.parse(a.at) - Date.parse(b.at);
  if (dt !== 0) return dt;
  const repo = a.repo.localeCompare(b.repo);
  if (repo !== 0) return repo;
  const own = a.ownership.localeCompare(b.ownership);
  if (own !== 0) return own;
  return a.minutes - b.minutes;
}

function compareTeamMerge(a: TeamMergeSample, b: TeamMergeSample): number {
  const dt = Date.parse(a.mergedAt) - Date.parse(b.mergedAt);
  if (dt !== 0) return dt;
  const repo = a.repo.localeCompare(b.repo);
  if (repo !== 0) return repo;
  return a.minutes - b.minutes;
}

/** Invariant checks used by tests and CI smoke runs. */
export function validateDashboardData(data: DashboardData): string[] {
  const problems: string[] = [];
  if (data.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  if (Date.parse(data.generatedAt) !== Date.parse(data.range.end)) {
    problems.push("generatedAt must equal range.end");
  }
  if (Date.parse(data.range.start) >= Date.parse(data.range.end)) {
    problems.push("range.start must be before range.end");
  }
  const monthOfStart = monthOf(data.range.start);
  const monthOfEnd = monthOf(data.range.end);
  const expectedMonths = monthRange(monthOfStart, monthOfEnd);
  const covKeys = new Set(data.coverage.map((c) => `${c.repo}|${c.month}`));
  for (const c of data.coverage) {
    if (!expectedMonths.includes(c.month)) problems.push(`coverage month ${c.month} outside range`);
  }
  const seenPrIds = new Set<string>();
  for (const pr of data.prs) {
    if (pr.id !== `${pr.repo}#${pr.number}`) problems.push(`bad pr id ${pr.id}`);
    if (seenPrIds.has(pr.id)) problems.push(`duplicate pr id ${pr.id}`);
    seenPrIds.add(pr.id);
    const joined = pr.reviewMonths.join(",");
    if (joined !== [...pr.reviewMonths].sort().join(",")) problems.push(`unsorted reviewMonths for ${pr.id}`);
    for (const m of pr.reviewMonths) {
      if (pr.reviewCountsByMonth[m] === undefined) problems.push(`missing count for ${pr.id} ${m}`);
    }
    for (const [m, n] of Object.entries(pr.reviewCountsByMonth)) {
      if (!pr.reviewMonths.includes(m)) problems.push(`orphan count month ${m} for ${pr.id}`);
      if (n < 1) problems.push(`non-positive count for ${pr.id} ${m}`);
    }
  }
  const rowKeys = new Set(data.months.map((r) => `${r.repo}|${r.month}`));
  for (const r of data.months) {
    if (!covKeys.has(`${r.repo}|${r.month}`)) problems.push(`month row ${r.repo}|${r.month} lacks coverage entry`);
    for (const [k, v] of Object.entries(r)) {
      if (k !== "month" && k !== "repo" && typeof v === "number" && v < 0) {
        problems.push(`negative ${k} in ${r.repo}|${r.month}`);
      }
    }
  }
  // month rows must be sorted and coverage must cover every repo×month in range
  const sortedRows = [...data.months].sort((a, b) =>
    a.month === b.month ? a.repo.localeCompare(b.repo) : a.month.localeCompare(b.month),
  );
  if (JSON.stringify(sortedRows) !== JSON.stringify(data.months)) problems.push("months not sorted");
  const repos = [...new Set(data.coverage.map((c) => c.repo))].sort();
  for (const repo of repos) {
    for (const m of expectedMonths) {
      if (!covKeys.has(`${repo}|${m}`)) problems.push(`missing coverage ${repo}|${m}`);
    }
  }
  void rowKeys;

  if (!Array.isArray(data.reviewers)) problems.push("reviewers must be an array");
  if (!Array.isArray(data.trends)) problems.push("trends must be an array");
  if (Array.isArray(data.reviewers) && Array.isArray(data.trends)) {
    const reviewerKeys = new Set<string>();
    const loginsByGroup = new Map<string, string[]>();
    const submissionSum = new Map<string, number>();
    for (const row of data.reviewers) {
      const path = `reviewer ${row.repo}|${row.month}|${row.login}`;
      if (!row.month || !row.repo || !row.login) problems.push(`incomplete ${path}`);
      const id = `${row.repo}|${row.month}|${row.login}`;
      if (reviewerKeys.has(id)) problems.push(`duplicate ${path}`);
      reviewerKeys.add(id);
      const group = `${row.repo}|${row.month}`;
      const logins = loginsByGroup.get(group) ?? [];
      logins.push(row.login);
      loginsByGroup.set(group, logins);
      const outcomes = row.approvals + row.changesRequested + row.comments + row.dismissed;
      if (outcomes !== row.reviewSubmissions) problems.push(`${path} outcomes ${outcomes} != submissions ${row.reviewSubmissions}`);
      if (row.reviewedPrs > row.reviewSubmissions) problems.push(`${path} reviewedPrs exceeds submissions`);
      for (const [k, v] of Object.entries(row)) {
        if (k !== "month" && k !== "repo" && k !== "login" && (typeof v !== "number" || v < 0)) {
          problems.push(`bad ${k} on ${path}`);
        }
      }
      if (row.repo !== ALL_REPOS) {
        submissionSum.set(group, (submissionSum.get(group) ?? 0) + row.reviewSubmissions);
      }
    }
    const loginOrders = [...loginsByGroup.values()].map((l) => l.join("\0"));
    if (new Set(loginOrders).size > 1) problems.push("reviewer login order is not stable across repo-months");
    const sortedReviewers = [...data.reviewers].sort((a, b) => {
      if (a.month !== b.month) return a.month.localeCompare(b.month);
      if (a.repo !== b.repo) return a.repo.localeCompare(b.repo);
      return data.reviewers.indexOf(a) - data.reviewers.indexOf(b);
    });
    // Month and repo must be grouped in order. Login order is the roster order,
    // checked for stability above, so re-sorting by the original index keeps it.
    if (data.reviewers.some((row, i) => row !== sortedReviewers[i])) {
      // Fall back to a direct adjacent check so a swapped month fails loudly.
      for (let i = 1; i < data.reviewers.length; i++) {
        const prev = data.reviewers[i - 1]!;
        const cur = data.reviewers[i]!;
        const cmp = prev.month === cur.month ? prev.repo.localeCompare(cur.repo) : prev.month.localeCompare(cur.month);
        if (cmp > 0) problems.push("reviewers not sorted");
      }
    }

    for (const r of data.months) {
      const key = `${r.repo}|${r.month}`;
      if (!loginsByGroup.has(key)) problems.push(`missing reviewer rows for ${key}`);
      else if ((submissionSum.get(key) ?? 0) !== r.reviewSubmissions) {
        problems.push(`reviewer submissions for ${key} do not match the month row`);
      }
    }

    const trendKeys = new Set<string>();
    for (const row of data.trends) {
      const path = `trend ${row.repo}|${row.month}`;
      if (trendKeys.has(`${row.repo}|${row.month}`)) problems.push(`duplicate ${path}`);
      trendKeys.add(`${row.repo}|${row.month}`);
      const outcomes = row.approvals + row.changesRequested + row.comments + row.dismissed;
      if (row.repo !== ALL_REPOS) {
        const month = data.months.find((m) => m.repo === row.repo && m.month === row.month);
        if (!month) problems.push(`${path} has no month row`);
        else if (outcomes !== month.reviewSubmissions) problems.push(`${path} outcomes do not match reviewSubmissions`);
        else if (row.reviewedPrs !== month.internalReviewedPrs + month.externalReviewedPrs) {
          problems.push(`${path} reviewedPrs do not match the month row`);
        }
      }
      if (row.multiReviewerPrs > row.reviewedPrs) problems.push(`${path} multiReviewerPrs exceeds reviewedPrs`);
      if (row.sizedReviewedPrs > row.reviewedPrs) problems.push(`${path} sizedReviewedPrs exceeds reviewedPrs`);
      const buckets = row.sizeSmall + row.sizeMedium + row.sizeLarge + row.sizeXLarge;
      if (buckets !== row.sizedReviewedPrs) problems.push(`${path} size buckets do not sum to sizedReviewedPrs`);
      if ((row.medianMinutesToFirstReview === null) !== (row.firstReviews === 0)) {
        problems.push(`${path} first-review median does not match its sample count`);
      }
      if ((row.medianMinutesReviewToMerge === null) !== (row.reviewedMerges === 0)) {
        problems.push(`${path} review-to-merge median does not match its sample count`);
      }
      if ((row.medianChangedLines === null) !== (row.sizedReviewedPrs === 0)) {
        problems.push(`${path} line median does not match sizedReviewedPrs`);
      }
      if ((row.medianChangedFiles === null) !== (row.sizedReviewedPrs === 0)) {
        problems.push(`${path} file median does not match sizedReviewedPrs`);
      }
      for (const [k, v] of Object.entries(row)) {
        if (k === "month" || k === "repo") continue;
        if (v === null) continue;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) problems.push(`bad ${k} on ${path}`);
      }
    }
    const sortedTrends = [...data.trends].sort((a, b) =>
      a.month === b.month ? a.repo.localeCompare(b.repo) : a.month.localeCompare(b.month),
    );
    if (JSON.stringify(sortedTrends) !== JSON.stringify(data.trends)) problems.push("trends not sorted");
    const monthsWithRows = new Set(data.months.map((r) => r.month));
    for (const m of monthsWithRows) {
      if (!trendKeys.has(`${ALL_REPOS}|${m}`)) problems.push(`missing rollup trend for ${m}`);
      if (!loginsByGroup.has(`${ALL_REPOS}|${m}`)) problems.push(`missing rollup reviewers for ${m}`);
    }
    for (const m of monthsWithRows) {
      const rollup = data.trends.find((t) => t.repo === ALL_REPOS && t.month === m);
      if (!rollup) continue;
      const parts = data.months.filter((row) => row.month === m);
      const submissions = parts.reduce((s, row) => s + row.reviewSubmissions, 0);
      const outcomes = rollup.approvals + rollup.changesRequested + rollup.comments + rollup.dismissed;
      if (outcomes !== submissions) problems.push(`rollup trend ${m} outcomes do not match summed month rows`);
    }
  }

  const countFields = [
    "internalReviewedPrs",
    "externalReviewedPrs",
    "reviewSubmissions",
    "reviewedUnmergedPrs",
    "mergedInternalPrs",
    "mergedExternalReviewedPrs",
  ] as const;
  if (!Array.isArray(data.weeks)) {
    problems.push("weeks must be an array");
  } else {
    const seenWeeks = new Set<string>();
    for (const w of data.weeks) {
      const key = `${w.repo}|${w.week}`;
      if (!WEEK_KEY_RE.test(w.week)) problems.push(`bad week key ${w.week}`);
      const startMs = Date.parse(w.weekStart);
      if (!Number.isFinite(startMs)) {
        problems.push(`bad weekStart for ${key}`);
      } else {
        const d = new Date(startMs);
        const midnightMonday =
          d.getUTCDay() === 1 &&
          d.getUTCHours() === 0 &&
          d.getUTCMinutes() === 0 &&
          d.getUTCSeconds() === 0 &&
          d.getUTCMilliseconds() === 0 &&
          d.toISOString() === w.weekStart;
        if (!midnightMonday) problems.push(`weekStart ${w.weekStart} is not Monday 00:00:00.000Z`);
        if (isoWeekKey(startMs) !== w.week) problems.push(`week ${w.week} does not match ${w.weekStart}`);
      }
      if (typeof w.partial !== "boolean") problems.push(`${key} partial must be boolean`);
      if (seenWeeks.has(key)) problems.push(`duplicate week ${key}`);
      seenWeeks.add(key);
      for (const field of countFields) {
        const v = w[field];
        if (!Number.isInteger(v) || v < 0) problems.push(`bad ${field} on ${key}`);
      }
    }
    const sortedWeeks = [...data.weeks].sort((a, b) =>
      a.week === b.week ? a.repo.localeCompare(b.repo) : a.week.localeCompare(b.week),
    );
    if (JSON.stringify(sortedWeeks) !== JSON.stringify(data.weeks)) problems.push("weeks not sorted");

    // Submissions and merges each have one timestamp, so the weekly totals
    // equal the monthly totals for the same repo (boundary weeks keep the
    // events that fall in collected months).
    const reposWithMonths = [...new Set(data.months.map((r) => r.repo))];
    for (const repo of reposWithMonths) {
      for (const field of ["reviewSubmissions", "mergedInternalPrs", "mergedExternalReviewedPrs"] as const) {
        const monthSum = data.months.filter((r) => r.repo === repo).reduce((s, r) => s + r[field], 0);
        const weekSum = data.weeks.filter((r) => r.repo === repo).reduce((s, r) => s + r[field], 0);
        if (monthSum !== weekSum) problems.push(`${repo} ${field}: weeks ${weekSum} != months ${monthSum}`);
      }
    }
  }

  const rangeStartMs = Date.parse(data.range.start);
  const rangeEndMs = Date.parse(data.range.end);
  if (!Array.isArray(data.firstReviews)) {
    problems.push("firstReviews must be an array");
  } else {
    data.firstReviews.forEach((s, i) => {
      const t = Date.parse(s.at);
      if (!Number.isFinite(t)) problems.push(`firstReviews[${i}] bad at`);
      else if (Number.isFinite(rangeStartMs) && (t < rangeStartMs || t >= rangeEndMs)) {
        problems.push(`firstReviews[${i}] outside range`);
      }
      if (s.ownership !== "internal" && s.ownership !== "external") problems.push(`firstReviews[${i}] bad ownership`);
      if (!Number.isInteger(s.minutes) || s.minutes < 0) problems.push(`firstReviews[${i}] bad minutes`);
      if (i > 0 && compareFirstReview(data.firstReviews[i - 1]!, s) > 0) problems.push("firstReviews not sorted");
    });
  }
  if (!Array.isArray(data.teamMerges)) {
    problems.push("teamMerges must be an array");
  } else {
    data.teamMerges.forEach((s, i) => {
      const t = Date.parse(s.mergedAt);
      if (!Number.isFinite(t)) problems.push(`teamMerges[${i}] bad mergedAt`);
      else if (Number.isFinite(rangeStartMs) && (t < rangeStartMs || t >= rangeEndMs)) {
        problems.push(`teamMerges[${i}] outside range`);
      }
      if (!Number.isInteger(s.minutes) || s.minutes < 0) problems.push(`teamMerges[${i}] bad minutes`);
      if (i > 0 && compareTeamMerge(data.teamMerges[i - 1]!, s) > 0) problems.push("teamMerges not sorted");
    });
  }
  return problems;
}

const WEEK_KEY_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
