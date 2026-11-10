import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  deriveAggregatesFromPrs,
  parseDashboardJson,
  validateDashboardData,
} from '../../src/data/validate'
import type { DashboardData } from '../../src/data/types'

const demo: DashboardData = JSON.parse(
  readFileSync(new URL('../../src/data/demo-fixture.json', import.meta.url), 'utf8'),
) as DashboardData

describe('parseDashboardJson', () => {
  test('parses valid JSON', () => {
    const r = parseDashboardJson('{"schemaVersion":1}')
    expect(r.data as unknown).toEqual({ schemaVersion: 1 })
  })
  test('reports parse errors for malformed JSON', () => {
    const r = parseDashboardJson('{"schemaVersion":1,,}')
    expect(r.parseError).toContain('Invalid JSON')
    expect(r.data).toBeUndefined()
  })
  test('reports empty files', () => {
    const r = parseDashboardJson('   ')
    expect(r.parseError).toContain('empty')
  })
})

describe('validateDashboardData — demo fixture', () => {
  test('passes with zero errors and zero warnings', () => {
    const r = validateDashboardData(demo)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })
})

describe('validateDashboardData — structural rules', () => {
  const base = (): DashboardData => JSON.parse(JSON.stringify(demo))

  test('rejects a missing weeks array without throwing', () => {
    const d = base() as unknown as { weeks?: unknown }
    delete d.weeks
    const r = validateDashboardData(d as unknown as DashboardData)
    expect(r.errors.some((e) => e.path === '$.weeks' && /expected an array/.test(e.message))).toBe(true)
  })

  test('rejects a week key that is not an ISO week', () => {
    const d = base()
    d.weeks[0]!.week = '2026-W54'
    expect(validateDashboardData(d).errors.some((e) => e.path === '$.weeks[0].week')).toBe(true)
  })

  test('rejects wrong schemaVersion', () => {
    const d = base()
    d.schemaVersion = 2
    const r = validateDashboardData(d)
    expect(r.errors.some((e) => e.path === '$.schemaVersion')).toBe(true)
  })

  test('rejects non-ISO generatedAt', () => {
    const d = base()
    d.generatedAt = 'yesterday'
    expect(validateDashboardData(d).errors.some((e) => e.path === '$.generatedAt')).toBe(true)
  })

  test('rejects range end on or before start', () => {
    const d = base()
    d.range = { start: '2026-11-01T00:00:00Z', end: '2026-07-01T00:00:00Z' }
    expect(validateDashboardData(d).errors.some((e) => e.path === '$.range.end')).toBe(true)
  })

  test('rejects negative and non-integer counts', () => {
    const d = base()
    d.months[0]!.internalReviewedPrs = -5
    d.months[1]!.reviewSubmissions = 1.5
    const r = validateDashboardData(d)
    expect(r.errors.some((e) => e.path.includes('internalReviewedPrs'))).toBe(true)
    expect(r.errors.some((e) => e.path.includes('reviewSubmissions'))).toBe(true)
  })

  test('rejects malformed month keys', () => {
    const d = base()
    d.months[0]!.month = '2026-13'
    expect(validateDashboardData(d).errors.some((e) => e.path === '$.months[0].month')).toBe(true)
  })

  test('rejects invalid coverage status enum', () => {
    const d = base()
    d.coverage[0]!.status = 'maybe' as never
    expect(validateDashboardData(d).errors.some((e) => e.path === '$.coverage[0].status')).toBe(true)
  })

  test('rejects invalid PR enums and non-https URLs', () => {
    const d = base()
    d.prs[0]!.ownership = 'somehow' as never
    d.prs[0]!.state = 'merged' as never
    d.prs[0]!.url = 'http://example.com/pr/1'
    const r = validateDashboardData(d)
    expect(r.errors.some((e) => e.path.includes('ownership'))).toBe(true)
    expect(r.errors.some((e) => e.path.includes('state'))).toBe(true)
    expect(r.errors.some((e) => e.path.includes('url'))).toBe(true)
  })

  test('requires mergedAt on MERGED PRs', () => {
    const d = base()
    d.prs[0]!.state = 'MERGED'
    d.prs[0]!.mergedAt = null
    expect(validateDashboardData(d).errors.some((e) => e.path.includes('mergedAt'))).toBe(true)
  })

  test('warns on duplicate repo-month rows', () => {
    const d = base()
    d.months.push({ ...d.months[0]! })
    const r = validateDashboardData(d)
    expect(r.warnings.some((w) => w.message.includes('duplicate entry'))).toBe(true)
  })

  test('warns on id not matching repo#number', () => {
    const d = base()
    d.prs[0]!.id = 'wrong'
    const r = validateDashboardData(d)
    expect(r.warnings.some((w) => w.path.includes('$.prs[0].id'))).toBe(true)
  })

  test('warns on PR reviewMonths missing from months[]', () => {
    const d = base()
    d.prs[0]!.reviewMonths = [...d.prs[0]!.reviewMonths, '2030-01']
    const r = validateDashboardData(d)
    expect(r.warnings.some((w) => w.message.includes('2030-01'))).toBe(true)
  })

  test('warns when months[] aggregates disagree with PR-level derivation', () => {
    const d = base()
    d.months[0]!.internalReviewedPrs += 3
    const r = validateDashboardData(d)
    expect(r.warnings.some((w) => w.message.includes('internalReviewedPrs'))).toBe(true)
  })

  test('warns when coverage is empty but months exist', () => {
    const d = base()
    d.coverage = []
    const r = validateDashboardData(d)
    expect(r.warnings.some((w) => w.path === '$.coverage')).toBe(true)
  })
})

describe('deriveAggregatesFromPrs — demo fixture consistency', () => {
  test('months[] exactly matches PR-level derivation for every repo-month', () => {
    const derived = deriveAggregatesFromPrs(demo.prs)
    for (const row of demo.months) {
      const d = derived.get(`${row.repo}|${row.month}`)
      expect(d?.internalReviewedPrs).toBe(row.internalReviewedPrs)
      expect(d?.externalReviewedPrs).toBe(row.externalReviewedPrs)
      expect(d?.reviewSubmissions).toBe(row.reviewSubmissions)
      expect(d?.reviewedUnmergedPrs).toBe(row.reviewedUnmergedPrs)
      expect(d?.mergedInternalPrs).toBe(row.mergedInternalPrs)
      expect(d?.mergedExternalReviewedPrs).toBe(row.mergedExternalReviewedPrs)
    }
  })

  test('reviewed PR counts never double-count a PR within one month', () => {
    // unique (repo, number, month) triples across reviewMonths
    const seen = new Set<string>()
    for (const pr of demo.prs) {
      for (const m of pr.reviewMonths) {
        const key = `${pr.repo}#${pr.number}|${m}`
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
    }
  })

  test('mergedExternalReviewedPrs only counts reviews at/before merge', () => {
    for (const pr of demo.prs) {
      if (pr.ownership === 'external' && pr.state === 'MERGED' && pr.mergedAt) {
        const mergedMonth = pr.mergedAt.slice(0, 7)
        const qualifies = pr.reviewMonths.some((m) => m <= mergedMonth)
        expect(qualifies).toBe(true) // fixture: external merges always carry a pre-merge review
      }
    }
  })
})

describe('demo fixture privacy invariants', () => {
  const roster = [
    'bergarces', 'sahar-fehri', 'Prithpal-Sooriya', 'Kriys94', 'salimtb',
    'juanmigdr', 'dawnseeker8', 'amandaye0h', 'amitabh94',
  ]
  test('contains no reviewer or roster logins anywhere', () => {
    const raw = JSON.stringify(demo).toLowerCase()
    for (const login of roster) {
      expect(raw.includes(login.toLowerCase())).toBe(false)
    }
  })
  test('uses fake high PR numbers so links cannot resolve to real PRs', () => {
    for (const pr of demo.prs) {
      expect(pr.number).toBeGreaterThanOrEqual(900000)
    }
  })
  test('labels the data as demo in methodology notes', () => {
    expect(demo.methodology.notes.some((n) => n.includes('DEMO SAMPLE DATA'))).toBe(true)
  })
})

describe('validateDashboardData — hostile shapes must not throw', () => {
  const base = (): DashboardData => JSON.parse(JSON.stringify(demo))

  test('missing months array yields errors, not a TypeError', () => {
    const d = base() as unknown as { months?: unknown }
    delete d.months
    const r = validateDashboardData(d as unknown as DashboardData)
    expect(r.errors.some((e) => e.path === '$.months' && /expected an array/.test(e.message))).toBe(true)
  })

  test('null months yields errors, not a TypeError', () => {
    const d = base() as unknown as { months?: unknown }
    d.months = null
    const r = validateDashboardData(d as unknown as DashboardData)
    expect(r.errors.some((e) => e.path === '$.months')).toBe(true)
  })

  test('non-array coverage alongside valid months yields errors, not a TypeError', () => {
    const d = base() as unknown as { coverage?: unknown }
    d.coverage = 'not-a-list'
    const r = validateDashboardData(d as unknown as DashboardData)
    expect(r.errors.some((e) => e.path === '$.coverage' && /expected an array/.test(e.message))).toBe(true)
  })

  test('missing months AND non-array coverage together yield errors, not a TypeError', () => {
    const d = base() as unknown as { months?: unknown; coverage?: unknown }
    delete d.months
    d.coverage = 7
    const r = validateDashboardData(d as unknown as DashboardData)
    expect(r.errors.some((e) => e.path === '$.months')).toBe(true)
    expect(r.errors.some((e) => e.path === '$.coverage')).toBe(true)
  })
})
