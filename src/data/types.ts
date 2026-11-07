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
}
