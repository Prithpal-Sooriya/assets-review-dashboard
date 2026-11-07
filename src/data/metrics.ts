import type { CoverageEntry, CoverageStatus, DashboardData, MonthEntry, PrEntry } from './types'
import { compareRepos } from './format'

export interface MonthAggregate {
  month: string
  internalReviewedPrs: number
  externalReviewedPrs: number
  reviewSubmissions: number
  reviewedUnmergedPrs: number
  mergedInternalPrs: number
  mergedExternalReviewedPrs: number
}

export const DISPLAY_MONTHS = 13 // 12 completed calendar months + current partial month

/** Unique, ascending month keys present anywhere in the dataset. */
export function orderedMonthKeys(months: MonthEntry[]): string[] {
  const keys = new Set<string>()
  for (const m of months) keys.add(m.month)
  return Array.from(keys).sort()
}

/**
 * Default rolling display window: the trailing 12 completed calendar months
 * plus the current partial month (13 keys). Earlier months are omitted from
 * the default view.
 */
export function displayWindow(monthKeys: string[]): { shown: string[]; omittedCount: number } {
  const sorted = [...monthKeys].sort()
  if (sorted.length <= DISPLAY_MONTHS) {
    return { shown: sorted, omittedCount: 0 }
  }
  return {
    shown: sorted.slice(sorted.length - DISPLAY_MONTHS),
    omittedCount: sorted.length - DISPLAY_MONTHS,
  }
}

/** Repos referenced by months/coverage, in canonical order. */
export function reposInData(months: MonthEntry[], coverage: CoverageEntry[]): string[] {
  const repos = new Set<string>()
  for (const m of months) repos.add(m.repo)
  for (const c of coverage) repos.add(c.repo)
  return Array.from(repos).sort(compareRepos)
}

/** Aggregate months[] rows across repos (null = all repos) restricted to the display window. */
export function aggregateMonths(
  months: MonthEntry[],
  repoFilter: string | null,
  windowMonths: string[],
): MonthAggregate[] {
  const byMonth = new Map<string, MonthAggregate>()
  for (const month of windowMonths) {
    byMonth.set(month, {
      month,
      internalReviewedPrs: 0,
      externalReviewedPrs: 0,
      reviewSubmissions: 0,
      reviewedUnmergedPrs: 0,
      mergedInternalPrs: 0,
      mergedExternalReviewedPrs: 0,
    })
  }
  for (const entry of months) {
    if (repoFilter !== null && entry.repo !== repoFilter) continue
    const agg = byMonth.get(entry.month)
    if (!agg) continue
    agg.internalReviewedPrs += entry.internalReviewedPrs
    agg.externalReviewedPrs += entry.externalReviewedPrs
    agg.reviewSubmissions += entry.reviewSubmissions
    agg.reviewedUnmergedPrs += entry.reviewedUnmergedPrs
    agg.mergedInternalPrs += entry.mergedInternalPrs
    agg.mergedExternalReviewedPrs += entry.mergedExternalReviewedPrs
  }
  return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month))
}

export function totalAggregate(aggregates: MonthAggregate[]): MonthAggregate {
  const total: MonthAggregate = {
    month: '',
    internalReviewedPrs: 0,
    externalReviewedPrs: 0,
    reviewSubmissions: 0,
    reviewedUnmergedPrs: 0,
    mergedInternalPrs: 0,
    mergedExternalReviewedPrs: 0,
  }
  for (const a of aggregates) {
    total.internalReviewedPrs += a.internalReviewedPrs
    total.externalReviewedPrs += a.externalReviewedPrs
    total.reviewSubmissions += a.reviewSubmissions
    total.reviewedUnmergedPrs += a.reviewedUnmergedPrs
    total.mergedInternalPrs += a.mergedInternalPrs
    total.mergedExternalReviewedPrs += a.mergedExternalReviewedPrs
  }
  return total
}

/** PRs with a qualifying team review in the given month (optionally one repo). */
export function prsReviewedIn(prs: PrEntry[], month: string, repoFilter: string | null): PrEntry[] {
  return prs.filter(
    (pr) =>
      (repoFilter === null || pr.repo === repoFilter) &&
      pr.reviewMonths.includes(month),
  )
}

export function comparePrs(a: PrEntry, b: PrEntry): number {
  if (a.repo !== b.repo) return compareRepos(a.repo, b.repo)
  return b.number - a.number
}

export interface CoverageLookup {
  get(repo: string, month: string): CoverageEntry | undefined
  missing: number
}

export function coverageLookup(coverage: CoverageEntry[]): CoverageLookup {
  const map = new Map<string, CoverageEntry>()
  for (const c of coverage) map.set(`${c.repo}|${c.month}`, c)
  return {
    get(repo: string, month: string) {
      return map.get(`${repo}|${month}`)
    },
    missing: 0,
  }
}

/** Months whose coverage is not 'complete' (rendered hatched / flagged). */
export function incompleteCoverageMonths(coverage: CoverageEntry[]): Set<string> {
  const out = new Set<string>()
  for (const c of coverage) {
    if (c.status !== 'complete') out.add(c.month)
  }
  return out
}

export interface CoverageSummary {
  complete: number
  partial: number
  pending: number
  error: number
  missing: number
  total: number
}

export function coverageSummary(
  coverage: CoverageEntry[],
  repos: string[],
  windowMonths: string[],
): CoverageSummary {
  const lookup = coverageLookup(coverage)
  const summary: CoverageSummary = {
    complete: 0, partial: 0, pending: 0, error: 0, missing: 0, total: 0,
  }
  for (const repo of repos) {
    for (const month of windowMonths) {
      summary.total += 1
      const entry = lookup.get(repo, month)
      switch (entry?.status) {
        case 'complete': summary.complete += 1; break
        case 'partial': summary.partial += 1; break
        case 'pending': summary.pending += 1; break
        case 'error': summary.error += 1; break
        default: summary.missing += 1
      }
    }
  }
  return summary
}

export function isCoverageComplete(status: CoverageStatus | undefined): boolean {
  return status === 'complete'
}

/** Latest month key in the window (default drill-down selection). */
export function latestMonth(windowMonths: string[]): string | null {
  return windowMonths.length > 0 ? windowMonths[windowMonths.length - 1]! : null
}

export function countReviewedPrsInMonth(agg: MonthAggregate): number {
  return agg.internalReviewedPrs + agg.externalReviewedPrs
}
