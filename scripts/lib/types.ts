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

/** Counts shared by a month row and a week row. */
export interface ActivityCounts {
  internalReviewedPrs: number;
  externalReviewedPrs: number;
  reviewSubmissions: number;
  reviewedUnmergedPrs: number;
  mergedInternalPrs: number;
  mergedExternalReviewedPrs: number;
}

export interface MonthRow extends ActivityCounts {
  month: string;
  repo: string;
}

/**
 * One ISO week (Monday 00:00 UTC through the next Monday) for one repo.
 * `partial` is true when the week is clipped by the window or the cutoff,
 * or when part of the week falls in a month that was not collected.
 */
export interface WeekRow extends ActivityCounts {
  week: string; // "YYYY-Www"
  weekStart: string; // Monday 00:00:00.000Z
  repo: string;
  partial: boolean;
}

/**
 * Wait from PR creation to the earliest qualifying team review.
 * No PR identity — team-level only. Bucketed in the UI by `at`.
 */
export interface FirstReviewSample {
  repo: string;
  ownership: "internal" | "external";
  /** ISO timestamp of the earliest qualifying team review. */
  at: string;
  /** Whole minutes from createdAt to `at` (nearest minute). */
  minutes: number;
}

/**
 * Wait from creation to merge for one internal (team) PR.
 * No PR identity. Bucketed in the UI by `mergedAt`.
 */
export interface TeamMergeSample {
  repo: string;
  mergedAt: string;
  /** Whole minutes from createdAt to mergedAt (nearest minute). */
  minutes: number;
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
  prs: PrEntry[];
  /** ISO weeks overlapping the window. Same activity rules as `months`. */
  weeks: WeekRow[];
  /** One sample per PR whose first qualifying team review falls in the window. */
  firstReviews: FirstReviewSample[];
  /** One sample per internal PR merged in the window. */
  teamMerges: TeamMergeSample[];
}
