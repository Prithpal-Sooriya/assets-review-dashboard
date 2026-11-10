import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { CoverageEntry, DashboardData } from '../../src/data/types'
import {
  aggregateMonths,
  aggregateWeeks,
  coverageLookup,
  coverageSummary,
  displayWindow,
  durationSeries,
  incompleteCoverageMonths,
  latestMonth,
  monthPeriods,
  orderedMonthKeys,
  percentileMinutes,
  prsReviewedIn,
  reposInData,
  totalAggregate,
  weekPeriods,
  type Period,
} from '../../src/data/metrics'
import type { WeekEntry } from '../../src/data/types'
import { coverageWindowMonths, formatMonthKey, monthKeyOfISO, repoDisplayName } from '../../src/data/format'
import { coverageProblemEntries } from '../../src/components/CoveragePanel'

const demo: DashboardData = JSON.parse(
  readFileSync(new URL('../../src/data/demo-fixture.json', import.meta.url), 'utf8'),
) as DashboardData

describe('orderedMonthKeys / displayWindow', () => {
  test('unique ascending month keys', () => {
    const keys = orderedMonthKeys(demo.months)
    expect(keys).toEqual([...keys].sort())
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.length).toBe(13)
    expect(keys[0]).toBe('2025-11')
    expect(keys.at(-1)).toBe('2026-11')
  })

  test('caps display at 13 months with omitted count', () => {
    const keys = orderedMonthKeys(demo.months)
    const { shown, omittedCount } = displayWindow([...keys, '2024-10', '2024-11'])
    expect(shown.length).toBe(13)
    expect(omittedCount).toBe(2)
    expect(shown.at(-1)).toBe('2026-11')
  })

  test('shorter windows pass through untouched', () => {
    const { shown, omittedCount } = displayWindow(['2026-01', '2026-02'])
    expect(shown).toEqual(['2026-01', '2026-02'])
    expect(omittedCount).toBe(0)
  })
})

describe('aggregateMonths', () => {
  const keys = orderedMonthKeys(demo.months)

  test('all-repo aggregate equals the sum of per-repo rows', () => {
    const all = aggregateMonths(demo.months, null, keys)
    const repos = reposInData(demo.months, demo.coverage)
    const perRepo = repos.map((r) => aggregateMonths(demo.months, r, keys))
    for (let i = 0; i < all.length; i++) {
      for (const field of [
        'internalReviewedPrs', 'externalReviewedPrs', 'reviewSubmissions',
        'reviewedUnmergedPrs', 'mergedInternalPrs', 'mergedExternalReviewedPrs',
      ] as const) {
        const sum = perRepo.reduce((s, rows) => s + rows[i]![field], 0)
        expect(all[i]![field]).toBe(sum)
      }
    }
  })

  test('repo filter restricts to one repo', () => {
    const core = aggregateMonths(demo.months, 'MetaMask/core', keys)
    for (const row of core) {
      const src = demo.months.find((m) => m.repo === 'MetaMask/core' && m.month === row.month)
      expect(row.internalReviewedPrs).toBe(src?.internalReviewedPrs ?? 0)
    }
  })

  test('window restriction drops months outside the window', () => {
    const partial = aggregateMonths(demo.months, null, ['2026-05'])
    expect(partial.length).toBe(1)
    expect(partial[0]!.month).toBe('2026-05')
  })

  test('totals sum across the window', () => {
    const all = aggregateMonths(demo.months, null, keys)
    const total = totalAggregate(all)
    expect(total.internalReviewedPrs).toBe(all.reduce((s, a) => s + a.internalReviewedPrs, 0))
    expect(total.reviewSubmissions).toBe(all.reduce((s, a) => s + a.reviewSubmissions, 0))
  })
})

describe('prsReviewedIn', () => {
  test('returns PRs whose reviewMonths include the month', () => {
    const month = '2026-03'
    const prs = prsReviewedIn(demo.prs, month, null)
    expect(prs.length).toBeGreaterThan(0)
    for (const pr of prs) expect(pr.reviewMonths).toContain(month)
    const expected = demo.prs.filter((p) => p.reviewMonths.includes(month)).length
    expect(prs.length).toBe(expected)
  })

  test('respects the repo filter', () => {
    const prs = prsReviewedIn(demo.prs, '2026-03', 'MetaMask/metamask-mobile')
    for (const pr of prs) expect(pr.repo).toBe('MetaMask/metamask-mobile')
  })
})

describe('coverage helpers', () => {
  test('lookup and summary classify repo-months', () => {
    const lookup = coverageLookup(demo.coverage)
    expect(lookup.get('MetaMask/core', '2025-11')?.status).toBe('complete')
    expect(lookup.get('MetaMask/metamask-extension', '2025-12')?.status).toBe('partial')
    expect(lookup.get('MetaMask/core', '2026-11')?.status).toBe('partial')
    expect(lookup.get('MetaMask/core', '2000-01')).toBeUndefined()

    const repos = reposInData(demo.months, demo.coverage)
    const summary = coverageSummary(demo.coverage, repos, orderedMonthKeys(demo.months))
    expect(summary.total).toBe(39)
    expect(summary.complete).toBe(35)
    expect(summary.partial).toBe(4) // extension 2025-12 backfill + all three repos in the partial cutoff month
    expect(summary.pending).toBe(0)
  })

  test('incompleteCoverageMonths marks the partial months', () => {
    const partial = incompleteCoverageMonths(demo.coverage)
    expect(partial.has('2025-12')).toBe(true)
    expect(partial.has('2026-11')).toBe(true)
    expect(partial.has('2025-11')).toBe(false)
  })
})

describe('coverageWindowMonths (full collection window for the coverage panel)', () => {
  test('enumerates range.start..range.end inclusive, crossing year boundaries', () => {
    // The real dataset's range: 13 months, 2025-11 .. 2026-11
    const months = coverageWindowMonths({ start: '2025-11-01T00:00:00.000Z', end: '2026-11-07T13:30:26.843Z' })
    expect(months).toHaveLength(13)
    expect(months[0]).toBe('2025-11')
    expect(months[months.length - 1]).toBe('2026-11')
    expect(months).toEqual([...months].sort())
  })

  test('single-month and multi-month ranges', () => {
    expect(coverageWindowMonths({ start: '2026-07-01T00:00:00Z', end: '2026-07-31T00:00:00Z' })).toEqual(['2026-07'])
    expect(coverageWindowMonths({ start: '2026-07-01T00:00:00Z', end: '2026-11-15T00:00:00Z' })).toEqual([
      '2026-07', '2026-08', '2026-09', '2026-10', '2026-11',
    ])
  })

  test('out-of-order or invalid ranges yield an empty window (no runaway loops)', () => {
    expect(coverageWindowMonths({ start: '2026-11-01T00:00:00Z', end: '2025-11-01T00:00:00Z' })).toEqual([])
    expect(coverageWindowMonths({ start: 'not-a-date', end: '2026-11-01T00:00:00Z' })).toEqual([])
    expect(coverageWindowMonths({ start: '2025-11-01T00:00:00Z', end: '' })).toEqual([])
    expect(coverageWindowMonths({ start: '2026-07-01T00:00:00Z', end: '2026-07-01T00:00:00Z' })).toEqual([])
  })

  test('range.end is exclusive: midnight of the 1st contributes no month of its own', () => {
    // …→ 2026-11-01T00:00:00Z contains zero days of Nov 2026 — the window
    // must stop at Oct 2026, not add an empty trailing month.
    expect(coverageWindowMonths({ start: '2026-07-01T00:00:00Z', end: '2026-11-01T00:00:00Z' })).toEqual([
      '2026-07', '2026-08', '2026-09', '2026-10',
    ])
    // Millisecond-precision boundary behaves the same
    expect(coverageWindowMonths({ start: '2026-07-01T00:00:00Z', end: '2026-11-01T00:00:00.000Z' })).toHaveLength(4)
    // One second past midnight DOES include the month
    expect(coverageWindowMonths({ start: '2026-07-01T00:00:00Z', end: '2026-11-01T00:00:01Z' })).toHaveLength(5)
    // Midnight on a non-1st day is a normal inclusive end
    expect(coverageWindowMonths({ start: '2026-07-01T00:00:00Z', end: '2026-11-07T00:00:00Z' })).toHaveLength(5)
    // Year boundary: …→ 2027-01-01T00:00:00Z stops at Dec 2026
    expect(coverageWindowMonths({ start: '2025-11-01T00:00:00Z', end: '2027-01-01T00:00:00Z' })).toHaveLength(14)
  })

  test('a pathological multi-year range is capped, never unbounded', () => {
    const months = coverageWindowMonths({ start: '1900-01-01T00:00:00Z', end: '2900-01-01T00:00:00Z' })
    expect(months.length).toBeLessThanOrEqual(1200)
  })
})

describe('coverageProblemEntries (the panel\'s full-disclosure list)', () => {
  const repos = ['MetaMask/core', 'MetaMask/metamask-mobile']

  test('non-complete entries are listed most-severe-first (error > partial > missing > pending)', () => {
    const coverage: CoverageEntry[] = [
      { repo: 'MetaMask/core', month: '2026-07', status: 'pending', detail: 'not collected' },
      { repo: 'MetaMask/metamask-mobile', month: '2026-07', status: 'partial', detail: 'capped' },
      { repo: 'MetaMask/core', month: '2026-08', status: 'error', detail: 'boom' },
    ]
    const problems = coverageProblemEntries(coverage, repos, ['2026-07', '2026-08'])
    expect(problems.map((p) => `${p.status}:${p.repo}:${p.month}`)).toEqual([
      'error:MetaMask/core:2026-08',
      'partial:MetaMask/metamask-mobile:2026-07',
      'missing:MetaMask/metamask-mobile:2026-08',
      'pending:MetaMask/core:2026-07',
    ])
  })

  test('in-window repo-months with NO coverage entry are listed as missing', () => {
    const coverage: CoverageEntry[] = [{ repo: 'MetaMask/core', month: '2026-07', status: 'complete' }]
    const problems = coverageProblemEntries(coverage, repos, ['2026-07', '2026-08'])
    expect(problems).toEqual([
      { repo: 'MetaMask/metamask-mobile', month: '2026-07', status: 'missing' },
      { repo: 'MetaMask/core', month: '2026-08', status: 'missing' },
      { repo: 'MetaMask/metamask-mobile', month: '2026-08', status: 'missing' },
    ])
  })

  test('non-complete entries OUTSIDE the derived window stay listed (never hidden)', () => {
    const coverage: CoverageEntry[] = [{ repo: 'MetaMask/core', month: '2030-01', status: 'error', detail: 'boom' }]
    const problems = coverageProblemEntries(coverage, repos, ['2026-07'])
    expect(problems[0]).toMatchObject({ month: '2030-01', status: 'error' })
    // plus the in-window missing entries
    expect(problems).toHaveLength(1 + repos.length)
  })

  test('duplicate repo|month entries collapse last-wins (grid and list agree)', () => {
    const coverage: CoverageEntry[] = [
      { repo: 'MetaMask/core', month: '2026-07', status: 'complete' },
      { repo: 'MetaMask/core', month: '2026-07', status: 'error', detail: 'late failure' },
    ]
    const problems = coverageProblemEntries(coverage, repos, ['2026-07'])
    expect(problems.filter((p) => p.repo === 'MetaMask/core' && p.month === '2026-07')).toEqual([
      { repo: 'MetaMask/core', month: '2026-07', status: 'error', detail: 'late failure' },
    ])
  })

  test('the real dataset shape yields exactly 29 pending entries, none missing', () => {
    // frozen snapshot fields from the real data/dashboard.json @ 2026-11-07
    // (all three fixture repos — the real coverage is complete metadata for
    // every in-window repo-month, so 'missing' cannot appear)
    const coverage: CoverageEntry[] = JSON.parse(
      readFileSync(new URL('./fixtures/sample-real.json', import.meta.url), 'utf8'),
    ).coverage
    const allRepos = [...new Set(coverage.map((c) => c.repo))]
    expect(allRepos).toHaveLength(3)
    const months = coverageWindowMonths({ start: '2025-11-01T00:00:00.000Z', end: '2026-11-07T13:30:26.843Z' })
    const problems = coverageProblemEntries(coverage, allRepos, months)
    expect(problems).toHaveLength(29)
    expect(problems.every((p) => p.status === 'pending')).toBe(true)
  })
})

describe('formatting helpers', () => {
  test('month key formatting', () => {
    expect(formatMonthKey('2025-11')).toBe('Nov 2025')
    expect(formatMonthKey('2026-01')).toBe('Jan 2026')
  })
  test('monthKeyOfISO extracts UTC month', () => {
    expect(monthKeyOfISO('2026-03-14T23:30:00Z')).toBe('2026-03')
  })
  test('repo display names', () => {
    expect(repoDisplayName('MetaMask/core')).toBe('Core')
    expect(repoDisplayName('MetaMask/metamask-mobile')).toBe('Mobile')
    expect(repoDisplayName('MetaMask/metamask-extension')).toBe('Extension')
    expect(repoDisplayName('MetaMask/extension')).toBe('Extension')
    expect(repoDisplayName('Other/repo')).toBe('Other/repo')
  })
  test('latestMonth picks the trailing month', () => {
    expect(latestMonth(['2026-01', '2026-02', '2026-03'])).toBe('2026-03')
    expect(latestMonth([])).toBeNull()
  })
})

describe('weekly activity and timing', () => {
  const weeks: WeekEntry[] = [
    { week: '2026-W02', weekStart: '2026-01-05T00:00:00.000Z', repo: 'MetaMask/core', partial: false, internalReviewedPrs: 2, externalReviewedPrs: 1, reviewSubmissions: 4, reviewedUnmergedPrs: 1, mergedInternalPrs: 1, mergedExternalReviewedPrs: 0 },
    { week: '2026-W02', weekStart: '2026-01-05T00:00:00.000Z', repo: 'MetaMask/metamask-mobile', partial: true, internalReviewedPrs: 1, externalReviewedPrs: 0, reviewSubmissions: 1, reviewedUnmergedPrs: 0, mergedInternalPrs: 0, mergedExternalReviewedPrs: 1 },
    { week: '2026-W03', weekStart: '2026-01-12T00:00:00.000Z', repo: 'MetaMask/core', partial: false, internalReviewedPrs: 0, externalReviewedPrs: 3, reviewSubmissions: 3, reviewedUnmergedPrs: 0, mergedInternalPrs: 0, mergedExternalReviewedPrs: 0 },
  ]

  test('week periods dedupe repos and keep a partial flag', () => {
    const periods = weekPeriods(weeks, ['2026-01'])
    expect(periods.map((p) => p.key)).toEqual(['2026-W02', '2026-W03'])
    expect(periods[0]!.partial).toBe(true)
    expect(periods[1]!.partial).toBe(false)
  })

  test('aggregateWeeks sums repos and the filter keeps one', () => {
    const periods: Period[] = weekPeriods(weeks, ['2026-01'])
    const all = aggregateWeeks(weeks, null, periods)
    expect(all[0]!.internalReviewedPrs).toBe(3)
    expect(all[0]!.reviewSubmissions).toBe(5)
    expect(all[0]!.mergedExternalReviewedPrs).toBe(1)
    const core = aggregateWeeks(weeks, 'MetaMask/core', periods)
    expect(core[0]!.internalReviewedPrs).toBe(2)
    expect(core[1]!.externalReviewedPrs).toBe(3)
  })

  test('percentileMinutes interpolates and rounds to a minute', () => {
    expect(percentileMinutes([], 0.5)).toBeNull()
    expect(percentileMinutes([10], 0.75)).toBe(10)
    expect(percentileMinutes([10, 20, 30], 0.5)).toBe(20)
    expect(percentileMinutes([10, 20, 30, 40], 0.5)).toBe(25)
    expect(percentileMinutes([10, 20, 30, 40], 0.75)).toBe(33)
  })

  test('durationSeries median is over the samples, and the repo filter applies', () => {
    const periods: Period[] = [
      { key: '2026-W02', start: '2026-01-05T00:00:00.000Z', partial: false },
      { key: '2026-W03', start: '2026-01-12T00:00:00.000Z', partial: false },
    ]
    const samples = [
      { repo: 'MetaMask/core', at: '2026-01-06T00:00:00Z', minutes: 10 },
      { repo: 'MetaMask/core', at: '2026-01-07T00:00:00Z', minutes: 30 },
      { repo: 'MetaMask/metamask-mobile', at: '2026-01-06T00:00:00Z', minutes: 100 },
      { repo: 'MetaMask/core', at: '2026-01-13T00:00:00Z', minutes: 50 },
    ]
    const all = durationSeries(samples, 'week', periods, null)
    expect(all.points[0]!.count).toBe(3)
    expect(all.points[0]!.medianMinutes).toBe(30)
    expect(all.points[1]!.count).toBe(1)
    expect(all.summary).toEqual({ count: 4, medianMinutes: 40, p75Minutes: 63 })
    const core = durationSeries(samples, 'week', periods, 'MetaMask/core')
    expect(core.summary.count).toBe(3)
    expect(core.points[0]!.count).toBe(2)
    const months = monthPeriods(['2026-01'], '2026-02-01T00:00:00Z')
    expect(months[0]!.partial).toBe(false)
    expect(durationSeries(samples, 'month', months, null).summary.count).toBe(4)
  })
})
