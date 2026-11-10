/**
 * Shared types for the assets-review-dashboard collector.
 *
 * The dashboard contract is defined once here and emitted exactly by
 * scripts/lib/aggregate.ts. Raw partition types are the collector's
 * on-disk evidence format under data/raw/.
 */

/** Collector configuration (config/collector.json). */
export interface CollectorConfig {
  schemaVersion: number;
  repos: string[]; // "owner/name"
  roster: string[]; // reviewer logins (case-insensitive membership)
  excludedReviewers: string[]; // never counted as reviewers
  teamLabel: string; // sufficient internal-ownership signal
  metadataTeam: string; // provenance reference only
  displayWindowMonths: number; // completed months shown before the current partial month
  reviewStates: string[]; // qualifying submitted review states
  request: {
    perPage: number;
    maxRetries: number;
    retryBaseDelayMs: number;
    minDelayMs: number;
    rateCheckInterval: number;
    rateReserve: number;
  };
  methodologyVersion: string;
  methodologyNotes: string[];
}

// ============================================================================
// Raw on-disk formats (data/raw/)
// ============================================================================

/** A review by a roster member, as captured from the REST API. */
export interface RawReview {
  id: number;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  submittedAt: string | null; // null for PENDING
  authorLogin: string;
}

/**
 * Minimal PR snapshot. Deliberately excludes PR bodies, review bodies,
 * emails and any identity data beyond logins — the dashboard is
 * team-level only.
 */
export interface RawPrRecord {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  authorLogin: string | null;
  labels: string[];
  /**
   * Diff stats from GitHub at collection time. Absent on snapshots collected
   * before size was recorded, and absent when GitHub did not report them.
   * additions + deletions is the line count; changedFiles is the file count.
   */
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /** Reviews authored by roster members only (all states kept). */
  reviews: RawReview[];
}

/** Partition completeness semantics. */
export type PartitionCompleteness = "monthEnd" | "asOfCutoff";

/**
 * One repo-month partition: every PR whose updated_at fell inside the
 * month at collection time, with full review history for each.
 */
export interface RawPartition {
  schemaVersion: 1;
  repo: string; // "owner/name"
  month: string; // "YYYY-MM"
  completeness: PartitionCompleteness;
  collectedAt: string; // ISO UTC cutoff of the walk that closed this partition
  prCount: number;
  prs: RawPrRecord[];
}

export type PartitionStatus =
  | { status: "complete"; completeness: PartitionCompleteness; collectedAt: string; prCount: number }
  | { status: "pending"; detail?: string };
// NOTE: no "error" partition status — hard collection failures leave months
// as "pending" (or no entry), and the run record (data/raw/.last-run.json,
// stopped: "error") carries the failure detail. Coverage-level "error"
// (manifest complete but file missing) remains a live CoverageStatus.

/** data/raw/manifest.json — the source of truth for coverage. */
export interface Manifest {
  schemaVersion: 1;
  /** Keyed `${repo}|${month}`. */
  partitions: Record<string, PartitionStatus>;
}

/** Resumable per-repo walk state (data/raw/.inprogress/<repo-slug>.json). */
export interface WalkState {
  repo: string;
  floorMonth: string; // month the walk descends to (fromMonth)
  /** Months already closed during this walk (complete on disk). */
  closedMonths: string[];
  /** Per month bucket: PR records already fetched (keyed by PR number). */
  buckets: Record<string, Record<number, RawPrRecord>>;
}

// ============================================================================
// Dashboard contract (data/dashboard.json) — emitted verbatim by aggregate.ts
// ============================================================================

export interface CoverageEntry {
  repo: string;
  month: string;
  status: "complete" | "partial" | "pending" | "error";
  detail?: string;
}

export interface MonthRow {
  month: string;
  repo: string;
  internalReviewedPrs: number;
  externalReviewedPrs: number;
  reviewSubmissions: number;
  reviewedUnmergedPrs: number;
  mergedInternalPrs: number;
  mergedExternalReviewedPrs: number;
}

/**
 * Cross-repo rollup key on reviewer and trend rows. Not a GitHub repository.
 * Per-repo rows are summed into this row; medians are recomputed from the
 * pooled samples, not averaged.
 */
export const ALL_REPOS = "*";

/**
 * Qualifying reviews by one roster member in one repo-month.
 * `repo` is a configured repo or ALL_REPOS. Login spelling is the roster's.
 */
export interface ReviewerMonthRow {
  month: string;
  repo: string;
  login: string;
  reviewSubmissions: number;
  /** Distinct PRs with at least one qualifying review by this person in the month. */
  reviewedPrs: number;
  approvals: number;
  changesRequested: number;
  comments: number;
  dismissed: number;
}

/**
 * Team-level shape of the month: outcome mix, pace, how many people touched
 * each PR, and diff size where the snapshot recorded it.
 * Medians are null when the sample count is 0. Minutes are integers.
 */
export interface TrendMonthRow {
  month: string;
  repo: string;
  approvals: number;
  changesRequested: number;
  comments: number;
  dismissed: number;
  /** PRs with at least one qualifying review in the month. */
  reviewedPrs: number;
  /** Of those, PRs with qualifying reviews from two or more roster members. */
  multiReviewerPrs: number;
  /** PRs whose earliest qualifying review falls in this month. */
  firstReviews: number;
  /** Median minutes from createdAt to that first review. */
  medianMinutesToFirstReview: number | null;
  /** PRs merged this month with a qualifying review at or before merge. */
  reviewedMerges: number;
  /** Median minutes from the earliest such review to mergedAt. */
  medianMinutesReviewToMerge: number | null;
  /** Reviewed PRs whose snapshot has a diff size. */
  sizedReviewedPrs: number;
  /** Median of additions + deletions. */
  medianChangedLines: number | null;
  medianChangedFiles: number | null;
  /** Changed lines under 100, 100–499, 500–999, and 1000 or more. */
  sizeSmall: number;
  sizeMedium: number;
  sizeLarge: number;
  sizeXLarge: number;
}

export interface PrEntry {
  id: string; // `${repo}#${number}` — stable
  repo: string;
  number: number;
  title: string;
  url: string;
  ownership: "internal" | "external";
  ownershipReason: "team-label" | "team-author" | "other";
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
  reviewMonths: string[];
  reviewCountsByMonth: Record<string, number>;
  labels: string[];
}

export interface DashboardData {
  schemaVersion: 1;
  generatedAt: string; // ISO UTC
  range: { start: string; end: string }; // ISO inclusive start, exclusive end
  methodology: { version: string; notes: string[] };
  coverage: CoverageEntry[];
  months: MonthRow[];
  /** One row per roster member per emitted repo-month, plus an ALL_REPOS rollup. */
  reviewers: ReviewerMonthRow[];
  /** One row per emitted repo-month, plus an ALL_REPOS rollup. */
  trends: TrendMonthRow[];
  prs: PrEntry[];
}
