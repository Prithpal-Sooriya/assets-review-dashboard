import { describe, expect, test } from 'bun:test'
import {
  CycleBudget,
  isPossiblyRateLimitedStatus,
  isStale,
  parseRateHeaders,
  rateRetryAtMs,
} from '../../../src/today/ratelimit'

function headersOf(entries: Record<string, string>): { get(name: string): string | null } {
  const lower = Object.fromEntries(
    Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]),
  )
  return { get: (name: string) => lower[name.toLowerCase()] ?? null }
}

describe('parseRateHeaders', () => {
  test('parses numeric limit/remaining/reset', () => {
    const h = headersOf({
      'X-RateLimit-Limit': '60',
      'X-RateLimit-Remaining': '42',
      'X-RateLimit-Reset': '1799070000',
    })
    expect(parseRateHeaders(h)).toEqual({ limit: 60, remaining: 42, reset: 1799070000 })
  })

  test('missing or malformed headers yield nulls, never NaN', () => {
    expect(parseRateHeaders(headersOf({})).remaining).toBeNull()
    expect(parseRateHeaders(headersOf({ 'x-ratelimit-remaining': 'many' })).remaining).toBeNull()
  })
})

describe('rateRetryAtMs', () => {
  const NOW = 1_000_000

  test('Retry-After (secondary limit) wins when present', () => {
    const at = rateRetryAtMs(403, headersOf({ 'retry-after': '30' }), NOW)
    expect(at).toBe(NOW + 30_000)
  })

  test('falls back to X-RateLimit-Reset (primary limit)', () => {
    const at = rateRetryAtMs(403, headersOf({ 'x-ratelimit-reset': '2000' }), NOW)
    expect(at).toBe(2_000_000)
  })

  test('429 without hints backs off 60s', () => {
    expect(rateRetryAtMs(429, headersOf({}), NOW)).toBe(NOW + 60_000)
  })

  test('non-rate statuses return null — never a meaningless retry-now', () => {
    expect(rateRetryAtMs(500, headersOf({}), NOW)).toBeNull()
    expect(rateRetryAtMs(200, headersOf({}), NOW)).toBeNull()
  })
})

describe('isPossiblyRateLimitedStatus', () => {
  test('429 and 403 are POSSIBLE rate limits (headers decide)', () => {
    expect(isPossiblyRateLimitedStatus(429)).toBe(true)
    expect(isPossiblyRateLimitedStatus(403)).toBe(true)
    // Anything else is not even a candidate.
    expect(isPossiblyRateLimitedStatus(401)).toBe(false)
    expect(isPossiblyRateLimitedStatus(404)).toBe(false)
    expect(isPossiblyRateLimitedStatus(500)).toBe(false)
    expect(isPossiblyRateLimitedStatus(200)).toBe(false)
  })
})

describe('CycleBudget', () => {
  test('enforces the request cap', () => {
    const b = new CycleBudget(2, 0)
    expect(b.allow()).toEqual({ ok: true })
    b.spend()
    expect(b.allow()).toEqual({ ok: true })
    b.spend()
    expect(b.allow()).toEqual({ ok: false, reason: 'cap' })
  })

  test('stops at the remaining floor to preserve shared-IP quota', () => {
    const b = new CycleBudget(100, 10)
    b.observeRemaining(11)
    expect(b.allow()).toEqual({ ok: true })
    b.observeRemaining(10)
    expect(b.allow()).toEqual({ ok: false, reason: 'floor' })
  })

  test('null remaining observations never block (headers absent)', () => {
    const b = new CycleBudget(10, 10)
    b.observeRemaining(null)
    expect(b.allow()).toEqual({ ok: true })
  })
})

describe('staleness + retry schedule', () => {
  test('3h interval: fresh cache is not stale, 3h+ is', () => {
    const THREE_HOURS = 3 * 60 * 60 * 1000
    expect(isStale(0, THREE_HOURS - 1, THREE_HOURS)).toBe(false)
    expect(isStale(0, THREE_HOURS + 1, THREE_HOURS)).toBe(true)
  })

})
