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
import type {
  CollectorConfig,
  CoverageEntry,
  DashboardData,
  Manifest,
  MonthRow,
  PrEntry,
  RawPartition,
  RawPrRecord,
  RawReview,
} from "./types";
import {
  addMonths,
  loginSetLower,
  monthOf,
  monthRange,
  partitionKey,
  startOfMonthIso,
} from "./config";

export interface AggregateInput {
  config: CollectorConfig;
  /** ISO UTC instant treated as both generatedAt and the range end cutoff. */
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
 *  Reviews submitted after the asOf cutoff are defensively excluded. */
function qualifyingReviews(cfg: CollectorConfig, record: RawPrRecord, asOfMs: number): RawReview[] {
  const states = new Set(cfg.reviewStates);
  const roster = loginSetLowerCached(cfg);
  const authorLc = record.authorLogin?.toLowerCase();
  return record.reviews.filter((r) => {
    if (!r.submittedAt) return false; // PENDING or missing
    if (!states.has(r.state)) return false; // e.g. PENDING
    if (!roster.has(r.authorLogin.toLowerCase())) return false; // non-roster / excluded
    if (authorLc && r.authorLogin.toLowerCase() === authorLc) return false; // self-review
    if (Date.parse(r.submittedAt) >= asOfMs) return false; // after cutoff
    return true;
  });
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
      const qReviews = qualifyingReviews(cfg, record, asOfMs);
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

  // ---- Month rows (dependency-complete months only) -----------------------
  const monthRows: MonthRow[] = [];
  for (const repo of cfg.repos) {
    const resolved = repoRecords.get(repo)!;
    for (const m of monthsList) {
      const depsComplete = monthRange(m, currentMonth).every((dm) => {
        const key = partitionKey(repo, dm);
        const st = manifest.partitions[key];
        return st?.status === "complete" && loadedKeys.has(key);
      });
      if (!depsComplete) continue;
      const monthStartMs = Date.parse(startOfMonthIso(m));
      const monthEndMs = Date.parse(startOfMonthIso(addMonths(m, 1)));
      let internalReviewedPrs = 0;
      let externalReviewedPrs = 0;
      let reviewSubmissions = 0;
      let reviewedUnmergedPrs = 0;
      let mergedInternalPrs = 0;
      let mergedExternalReviewedPrs = 0;
      for (const rp of resolved) {
        const record = rp.record;
        const qReviews = qualifyingReviews(cfg, record, asOfMs);
        const inMonth = qReviews.filter((r) => {
          const t = Date.parse(r.submittedAt!);
          return t >= monthStartMs && t < monthEndMs && t < asOfMs;
        });
        if (inMonth.length > 0) {
          const internal = isInternal(cfg, record);
          if (internal) internalReviewedPrs++;
          else externalReviewedPrs++;
          reviewSubmissions += inMonth.length;
          if (record.state !== "MERGED") reviewedUnmergedPrs++;
        }
        if (record.mergedAt !== null) {
          const mergedMs = Date.parse(record.mergedAt);
          const mergedInMonth = mergedMs >= monthStartMs && mergedMs < monthEndMs && mergedMs < asOfMs;
          if (mergedInMonth) {
            if (isInternal(cfg, record)) {
              mergedInternalPrs++;
            } else if (qReviews.some((r) => Date.parse(r.submittedAt!) <= mergedMs)) {
              mergedExternalReviewedPrs++;
            }
          }
        }
      }
      monthRows.push({
        month: m,
        repo,
        internalReviewedPrs,
        externalReviewedPrs,
        reviewSubmissions,
        reviewedUnmergedPrs,
        mergedInternalPrs,
        mergedExternalReviewedPrs,
      });
    }
  }
  monthRows.sort((a, b) => (a.month === b.month ? a.repo.localeCompare(b.repo) : a.month.localeCompare(b.month)));

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
      } else if (st.status === "error") {
        coverage.push({ repo, month: m, status: "error", detail: st.detail ?? "collection error" });
      } else {
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
    prs: prEntries,
  };
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
  return problems;
}
