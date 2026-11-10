import { describe, expect, test } from 'bun:test'
import { buildWindowLabel, displayPath, formatDurationMinutes, maskQuotedValues, oneLine } from '../../src/data/format'

describe('buildWindowLabel', () => {
  test('contiguous window: months-with-data count, no gap suffix', () => {
    expect(buildWindowLabel(['2026-01', '2026-02', '2026-03'], undefined, 0)).toBe(
      'Window: Jan 2026 – Mar 2026 · 3 months with data',
    )
  })

  test('single month uses singular', () => {
    expect(buildWindowLabel(['2026-03'], undefined, 0)).toBe(
      'Window: Mar 2026 – Mar 2026 · 1 month with data',
    )
  })

  test('gap months are called out with honest pluralization', () => {
    expect(buildWindowLabel(['2026-01', '2026-03'], undefined, 1)).toBe(
      'Window: Jan 2026 – Mar 2026 · 2 months with data · 1 calendar month without data in window',
    )
    expect(buildWindowLabel(['2026-01', '2026-04'], undefined, 2)).toBe(
      'Window: Jan 2026 – Apr 2026 · 2 months with data · 2 calendar months without data in window',
    )
  })

  test('empty window falls back to the declared range (year-month of the ISO stamps)', () => {
    expect(buildWindowLabel([], { start: '2026-07-01T00:00:00Z', end: '2026-11-01T00:00:00Z' }, 0)).toBe(
      'Window: Jul 2026 – Nov 2026 · 0 months with data',
    )
  })

  test('empty window with no usable range degrades to empty strings', () => {
    expect(buildWindowLabel([], undefined, 0)).toBe('Window:  –  · 0 months with data')
    expect(buildWindowLabel([], { start: null, end: 7 }, 0)).toBe('Window:  –  · 0 months with data')
  })
})

describe('public display helpers', () => {
  test('maskQuotedValues masks long quoted values of any length', () => {
    const long = 'x'.repeat(500)
    expect(maskQuotedValues(`expected YYYY-MM, got "${long}"`)).toBe('expected YYYY-MM, got "…"')
  })

  test('maskQuotedValues keeps short quoted tokens readable', () => {
    expect(maskQuotedValues('expected "months" to be an array')).toBe('expected "months" to be an array')
  })

  test('maskQuotedValues leaves apostrophes (ordinary prose) untouched', () => {
    expect(maskQuotedValues("can't parse; doesn't match")).toBe("can't parse; doesn't match")
  })

  test('maskQuotedValues masks before oneLine so the cap cannot resurrect raw data', () => {
    const long = 'y'.repeat(400)
    const msg = `bad value "${long}" and more`
    expect(oneLine(maskQuotedValues(msg))).toBe('bad value "…" and more')
    // The old order (oneLine first) would cut the closing quote and fail open:
    expect(maskQuotedValues(oneLine(msg))).not.toContain(long)
  })

  test('displayPath reduces long paths to a repo-relative tail', () => {
    expect(displayPath('a/b/c/d/e.json')).toBe('c/d/e.json')
    expect(displayPath('data/dashboard.json')).toBe('data/dashboard.json')
    expect(displayPath('src/data/demo-fixture.json')).toBe('src/data/demo-fixture.json')
  })

  test('oneLine collapses to the first line and caps length', () => {
    expect(oneLine('first line\nsecond line')).toBe('first line')
    expect(oneLine('x'.repeat(200)).length).toBeLessThanOrEqual(161)
  })
})

describe('formatDurationMinutes', () => {
  test('formats minutes, hours and days, and a missing sample', () => {
    expect(formatDurationMinutes(null)).toBe('—')
    expect(formatDurationMinutes(0)).toBe('0m')
    expect(formatDurationMinutes(45)).toBe('45m')
    expect(formatDurationMinutes(90)).toBe('1.5h')
    expect(formatDurationMinutes(10 * 60)).toBe('10h')
    expect(formatDurationMinutes(36 * 60)).toBe('36h')
    expect(formatDurationMinutes(3 * 24 * 60)).toBe('3d')
    expect(formatDurationMinutes(2.5 * 24 * 60)).toBe('2.5d')
  })
})
