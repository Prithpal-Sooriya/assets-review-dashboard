import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { DashboardData } from '../../src/data/types'
import {
  aggregateMonths,
  coverageLookup,
  coverageSummary,
  displayWindow,
  incompleteCoverageMonths,
  latestMonth,
  orderedMonthKeys,
  prsReviewedIn,
  reposInData,
  totalAggregate,
} from '../../src/data/metrics'
import { coverageWindowMonths, formatMonthKey, monthKeyOfISO, repoDisplayName } from '../../src/data/format'

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

  test('single-month and same-month ranges', () => {
    expect(coverageWindowMonths({ start: '2026-07-01T00:00:00Z', end: '2026-07-31T00:00:00Z' })).toEqual(['2026-07'])
    expect(coverageWindowMonths({ start: '2026-07-01T00:00:00Z', end: '2026-11-01T00:00:00Z' })).toEqual([
      '2026-07', '2026-08', '2026-09', '2026-10', '2026-11',
    ])
  })

  test('out-of-order or invalid ranges yield an empty window (no runaway loops)', () => {
    expect(coverageWindowMonths({ start: '2026-11-01T00:00:00Z', end: '2025-11-01T00:00:00Z' })).toEqual([])
    expect(coverageWindowMonths({ start: 'not-a-date', end: '2026-11-01T00:00:00Z' })).toEqual([])
    expect(coverageWindowMonths({ start: '2025-11-01T00:00:00Z', end: '' })).toEqual([])
  })

  test('a pathological multi-year range is capped, never unbounded', () => {
    const months = coverageWindowMonths({ start: '1900-01-01T00:00:00Z', end: '2900-01-01T00:00:00Z' })
    expect(months.length).toBeLessThanOrEqual(1200)
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
