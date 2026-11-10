/**
 * Shared implementation contract v1 (binding).
 *
 * This file mirrors `interface DashboardData` from the contract exactly.
 * The collector branch (scripts/, config/) must emit JSON matching this
 * shape into data/dashboard.json; the dashboard embeds it at build time.
 */

export const SCHEMA_VERSION = 1

export type Ownership = 'internal' | 'external'
export type OwnershipReason = 'team-label' | 'team-author' | 'other'
export type PrState = 'OPEN' | 'CLOSED' | 'MERGED'
export type CoverageStatus = 'complete' | 'partial' | 'pending' | 'error'

export interface CoverageEntry {
  repo: string
  month: string
  status: CoverageStatus
  detail?: string
}

export interface MonthEntry {
  month: string
  repo: string
  internalReviewedPrs: number
  externalReviewedPrs: number
  reviewSubmissions: number
  reviewedUnmergedPrs: number
  mergedInternalPrs: number
  mergedExternalReviewedPrs: number
}

/** Cross-repo rollup on reviewer and trend rows. Not a GitHub repository. */
export const ALL_REPOS = '*'

export interface ReviewerMonthEntry {
  month: string
  repo: string
  login: string
  reviewSubmissions: number
  reviewedPrs: number
  approvals: number
  changesRequested: number
  comments: number
  dismissed: number
}

export interface TrendMonthEntry {
  month: string
  repo: string
  approvals: number
  changesRequested: number
  comments: number
  dismissed: number
  reviewedPrs: number
  multiReviewerPrs: number
  firstReviews: number
  medianMinutesToFirstReview: number | null
  reviewedMerges: number
  medianMinutesReviewToMerge: number | null
  sizedReviewedPrs: number
  medianChangedLines: number | null
  medianChangedFiles: number | null
  sizeSmall: number
  sizeMedium: number
  sizeLarge: number
  sizeXLarge: number
}

export interface PrEntry {
  id: string
  repo: string
  number: number
  title: string
  url: string
  ownership: Ownership
  ownershipReason: OwnershipReason
  state: PrState
  mergedAt: string | null
  reviewMonths: string[]
  reviewCountsByMonth: Record<string, number>
  labels: string[]
}

export interface DashboardData {
  schemaVersion: number
  generatedAt: string
  range: { start: string; end: string }
  methodology: { version: string; notes: string[] }
  coverage: CoverageEntry[]
  months: MonthEntry[]
  /** Absent on snapshots aggregated before roster rows existed. */
  reviewers?: ReviewerMonthEntry[]
  /** Absent on snapshots aggregated before trend rows existed. */
  trends?: TrendMonthEntry[]
  prs: PrEntry[]
}
