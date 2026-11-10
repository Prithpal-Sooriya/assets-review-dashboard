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

export interface ActivityCounts {
  internalReviewedPrs: number
  externalReviewedPrs: number
  reviewSubmissions: number
  reviewedUnmergedPrs: number
  mergedInternalPrs: number
  mergedExternalReviewedPrs: number
}

export interface MonthEntry extends ActivityCounts {
  month: string
  repo: string
}

/** ISO week (Monday 00:00 UTC) activity for one repository. */
export interface WeekEntry extends ActivityCounts {
  week: string
  weekStart: string
  repo: string
  partial: boolean
}

/**
 * Wait from creation to the earliest qualifying team review.
 * No pull-request identity.
 */
export interface FirstReviewSample {
  repo: string
  ownership: Ownership
  at: string
  minutes: number
}

/** Wait from creation to merge for one internal team pull request. */
export interface TeamMergeSample {
  repo: string
  mergedAt: string
  minutes: number
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
  prs: PrEntry[]
  weeks: WeekEntry[]
  firstReviews: FirstReviewSample[]
  teamMerges: TeamMergeSample[]
}
