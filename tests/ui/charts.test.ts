import { describe, expect, test } from 'bun:test'
import { calendarMonthSpan, displayWindow } from '../../src/data/metrics'
import { niceMax, niceTicks } from '../../src/charts/chartUtils'

describe('niceTicks', () => {
  test('small integer maxima produce unique, monotonic ticks', () => {
    expect(niceTicks(1, 5)).toEqual([0, 1])
    expect(niceTicks(2, 5)).toEqual([0, 1, 2])
    expect(niceTicks(3, 5)).toEqual([0, 1, 2, 3])
  })

  test('larger maxima produce exactly count+1 unique ticks ending at max', () => {
    expect(niceTicks(5, 5)).toEqual([0, 1, 2, 3, 4, 5])
    expect(niceTicks(10, 5)).toEqual([0, 2, 4, 6, 8, 10])
    expect(niceTicks(50, 5)).toEqual([0, 10, 20, 30, 40, 50])
    const t = niceTicks(niceMax(1234), 5)
    expect(new Set(t).size).toBe(t.length)
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(1234)
  })

  test('degenerate maxima collapse safely', () => {
    expect(niceTicks(0, 5)).toEqual([0])
    expect(niceTicks(-3, 5)).toEqual([0])
    expect(niceTicks(Number.NaN, 5)).toEqual([0])
  })
})

describe('displayWindow — gap honesty', () => {
  test('contiguous months report zero gaps', () => {
    const r = displayWindow(['2026-01', '2026-02', '2026-03'])
    expect(r.gapCount).toBe(0)
    expect(r.shown).toEqual(['2026-01', '2026-02', '2026-03'])
  })

  test('a missing calendar month inside the window is counted as a gap', () => {
    const r = displayWindow(['2026-01', '2026-03'])
    expect(r.gapCount).toBe(1)
    expect(r.shown).toEqual(['2026-01', '2026-03'])
  })

  test('gaps inside the displayed 13-month window are reported', () => {
    const keys = Array.from({ length: 15 }, (_, i) => {
      const year = 2025 + Math.floor((i + 3) / 12)
      const month = ((i + 3) % 12) + 1
      return `${year}-${String(month).padStart(2, '0')}`
    }).filter((k) => k !== '2026-05') // 14 contiguous keys minus one gap month
    const r = displayWindow(keys)
    expect(r.omittedCount).toBe(1) // 14 keys → 13 shown
    expect(r.gapCount).toBe(1) // the missing 2026-05 falls inside the shown window
  })

  test('sparse old keys count their gaps honestly within the shown span', () => {
    const r = displayWindow(['2024-01', '2026-01', '2026-02'])
    // 3 keys, all shown; the 2024-01 outlier stretches the span, so the
    // caption must report 23 calendar months without data, not "3 months".
    expect(r.gapCount).toBe(23)
    expect(r.omittedCount).toBe(0)
  })

  test('calendarMonthSpan counts inclusive months', () => {
    expect(calendarMonthSpan('2026-01', '2026-01')).toBe(1)
    expect(calendarMonthSpan('2026-01', '2026-12')).toBe(12)
    expect(calendarMonthSpan('2025-11', '2026-11')).toBe(13)
    expect(calendarMonthSpan('bad', '2026-11')).toBe(1)
  })
})
