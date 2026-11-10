import {
  ALL_REPOS,
  type CoverageEntry,
  type CoverageStatus,
  type MonthEntry,
  type PrEntry,
  type ReviewerMonthEntry,
  type TrendMonthEntry,
} from './types'
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
 * Default rolling display window: the trailing 13 distinct month keys present
 * in the data (nominally 12 completed calendar months + the current partial).
 * Earlier months are omitted from the default view.
 *
 * If a calendar month has no data at all (collection gap — no months[] row
 * for any repo), it simply has no key here; `gapCount` reports how many
 * calendar months inside the first..last span carry no data so the UI can
 * label the window honestly instead of implying a contiguous 13 months.
 */
export function displayWindow(monthKeys: string[]): {
  shown: string[]
  omittedCount: number
  gapCount: number
} {
  const sorted = [...monthKeys].sort()
  const shown = sorted.length <= DISPLAY_MONTHS ? sorted : sorted.slice(sorted.length - DISPLAY_MONTHS)
  const gapCount = shown.length === 0
    ? 0
    : calendarMonthSpan(shown[0]!, shown[shown.length - 1]!) - shown.length
  const omittedCount = sorted.length - shown.length
  return { shown, omittedCount, gapCount }
}

/** Number of calendar months from `start` to `end` inclusive (YYYY-MM keys). */
export function calendarMonthSpan(start: string, end: string): number {
  const s = /^(\d{4})-(\d{2})$/.exec(start)
  const e = /^(\d{4})-(\d{2})$/.exec(end)
  if (!s || !e) return 1
  const months = (Number(e[1]) - Number(s[1])) * 12 + (Number(e[2]) - Number(s[2]))
  return months >= 0 ? months + 1 : 1
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
  /** All unique repo|month entries, last duplicate wins (same semantics as get). */
  entries(): IterableIterator<CoverageEntry>
}

function lastWinsCoverage(coverage: CoverageEntry[]): Map<string, CoverageEntry> {
  const map = new Map<string, CoverageEntry>()
  for (const c of coverage) map.set(`${c.repo}|${c.month}`, c)
  return map
}

export function coverageLookup(coverage: CoverageEntry[]): CoverageLookup {
  const map = lastWinsCoverage(coverage)
  return {
    get(repo: string, month: string) {
      return map.get(`${repo}|${month}`)
    },
    entries() {
      return map.values()
    },
  }
}

/** Months whose coverage is not 'complete' (rendered hatched / flagged).
 * Last duplicate wins, matching the grid/summary (coverageLookup semantics). */
export function incompleteCoverageMonths(coverage: CoverageEntry[]): Set<string> {
  const out = new Set<string>()
  for (const c of lastWinsCoverage(coverage).values()) {
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

export interface PersonMonth {
  login: string
  reviewSubmissions: number
  reviewedPrs: number
}

export interface ReviewerMonthView {
  month: string
  people: PersonMonth[]
}

/**
 * Reviewer rows for the selected repo, or the cross-repo rollup when no
 * repo is selected. Login order is the order the rows were emitted (roster
 * order). Months in the window with no row contribute zeros.
 */
export function reviewerMonths(
  rows: ReviewerMonthEntry[] | undefined,
  repoFilter: string | null,
  windowMonths: string[],
): { months: ReviewerMonthView[]; logins: string[] } {
  const list = Array.isArray(rows) ? rows : []
  const repo = repoFilter ?? ALL_REPOS
  const chosen = list.filter((r) => r.repo === repo && windowMonths.includes(r.month))
  const logins: string[] = []
  for (const row of chosen) {
    if (!logins.includes(row.login)) logins.push(row.login)
  }
  if (logins.length === 0) return { months: [], logins: [] }
  const byMonth = new Map<string, ReviewerMonthView>()
  for (const month of windowMonths) {
    byMonth.set(month, {
      month,
      people: logins.map((login) => ({ login, reviewSubmissions: 0, reviewedPrs: 0 })),
    })
  }
  for (const row of chosen) {
    const view = byMonth.get(row.month)
    const slot = view?.people.find((p) => p.login === row.login)
    if (!slot) continue
    slot.reviewSubmissions += row.reviewSubmissions
    slot.reviewedPrs += row.reviewedPrs
  }
  return { months: [...byMonth.values()], logins }
}

export interface TrendView {
  month: string
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

function emptyTrend(month: string): TrendView {
  return {
    month,
    approvals: 0,
    changesRequested: 0,
    comments: 0,
    dismissed: 0,
    reviewedPrs: 0,
    multiReviewerPrs: 0,
    firstReviews: 0,
    medianMinutesToFirstReview: null,
    reviewedMerges: 0,
    medianMinutesReviewToMerge: null,
    sizedReviewedPrs: 0,
    medianChangedLines: null,
    medianChangedFiles: null,
    sizeSmall: 0,
    sizeMedium: 0,
    sizeLarge: 0,
    sizeXLarge: 0,
  }
}

/**
 * Trend rows for one repo, or the precomputed cross-repo rollup. Medians are
 * never summed: a missing rollup yields no series rather than an average of
 * averages.
 */
export function trendMonths(
  rows: TrendMonthEntry[] | undefined,
  repoFilter: string | null,
  windowMonths: string[],
): TrendView[] {
  const list = Array.isArray(rows) ? rows : []
  const repo = repoFilter ?? ALL_REPOS
  const chosen = new Map(list.filter((r) => r.repo === repo).map((r) => [r.month, r]))
  if (![...chosen.keys()].some((month) => windowMonths.includes(month))) return []
  return windowMonths.map((month) => {
    const row = chosen.get(month)
    if (!row) return emptyTrend(month)
    return {
      month,
      approvals: row.approvals,
      changesRequested: row.changesRequested,
      comments: row.comments,
      dismissed: row.dismissed,
      reviewedPrs: row.reviewedPrs,
      multiReviewerPrs: row.multiReviewerPrs,
      firstReviews: row.firstReviews,
      medianMinutesToFirstReview: row.medianMinutesToFirstReview,
      reviewedMerges: row.reviewedMerges,
      medianMinutesReviewToMerge: row.medianMinutesReviewToMerge,
      sizedReviewedPrs: row.sizedReviewedPrs,
      medianChangedLines: row.medianChangedLines,
      medianChangedFiles: row.medianChangedFiles,
      sizeSmall: row.sizeSmall,
      sizeMedium: row.sizeMedium,
      sizeLarge: row.sizeLarge,
      sizeXLarge: row.sizeXLarge,
    }
  })
}
