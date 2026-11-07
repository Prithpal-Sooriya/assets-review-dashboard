import { describe, expect, test } from 'bun:test'
import {
  applyFailureBackoff,
  shouldApplyBroadcast,
} from '../../../src/today/cycle-controller'

const BACKOFF = [5_000, 15_000, 45_000]

describe('applyFailureBackoff', () => {
  test('first failure waits 5s; each attempt escalates to the schedule', () => {
    const b1 = applyFailureBackoff({
      nowMs: 1000,
      attempt: 0,
      backoffMs: BACKOFF,
      outcomeRetryAtMs: null,
      currentAllowedAt: 2000,
    })
    expect(b1.nextAttempt).toBe(1)
    expect(b1.nextAllowedAt).toBe(1000 + 5_000) // backoff beats the min-sweep wall here

    const b2 = applyFailureBackoff({
      nowMs: 1000,
      attempt: 1,
      backoffMs: BACKOFF,
      outcomeRetryAtMs: null,
      currentAllowedAt: 0,
    })
    expect(b2.nextAllowedAt).toBe(1000 + 15_000)

    const b3 = applyFailureBackoff({
      nowMs: 1000,
      attempt: 2,
      backoffMs: BACKOFF,
      outcomeRetryAtMs: null,
      currentAllowedAt: 0,
    })
    expect(b3.nextAllowedAt).toBe(1000 + 45_000)
  })

  test('beyond the schedule, no further backoff — the staleness tick takes over', () => {
    const b = applyFailureBackoff({
      nowMs: 1000,
      attempt: 5,
      backoffMs: BACKOFF,
      outcomeRetryAtMs: null,
      currentAllowedAt: 0,
    })
    expect(b.nextAllowedAt).toBe(0) // no gate: only the 5-min staleness tick retries
    expect(b.nextAttempt).toBe(0)
  })

  test('a rate-limit reset wall pushes retry beyond the backoff time', () => {
    // Server says "you may retry at t=60000"; backoff alone would be t=6000.
    const b = applyFailureBackoff({
      nowMs: 1000,
      attempt: 0,
      backoffMs: BACKOFF,
      outcomeRetryAtMs: 60_000,
      currentAllowedAt: 0,
    })
    expect(b.nextAllowedAt).toBe(60_000)
  })

  test('the min-sweep interval is never shortened', () => {
    // A 30s min-sweep wall already in force beats a smaller backoff candidate.
    const b = applyFailureBackoff({
      nowMs: 1000,
      attempt: 0,
      backoffMs: [0],
      outcomeRetryAtMs: 0,
      currentAllowedAt: 30_000,
    })
    expect(b.nextAllowedAt).toBe(30_000)
  })

  test('exhausted schedule hands back to the staleness tick (attempt resets)', () => {
    const b = applyFailureBackoff({
      nowMs: 1000,
      attempt: 2,
      backoffMs: [5_000, 5_000],
      outcomeRetryAtMs: null,
      currentAllowedAt: 0,
    })
    expect(b.nextAttempt).toBe(0)
    expect(b.nextAllowedAt).toBe(0)
  })
})

describe('shouldApplyBroadcast', () => {
  const base = { type: 'cycle', authMode: 'anonymous' as const, outcome: { status: 'complete' } }

  test('applies matching-auth broadcasts', () => {
    expect(shouldApplyBroadcast(base, 'anonymous')).toBe(true)
    expect(shouldApplyBroadcast({ ...base, authMode: 'token' }, 'token')).toBe(true)
  })

  test('never applies another auth mode\u2019s results (visibility differs)', () => {
    // Token tab collected (sees team requests); anonymous tab must not render
    // token-only data — and vice versa.
    expect(shouldApplyBroadcast({ ...base, authMode: 'token' }, 'anonymous')).toBe(false)
    expect(shouldApplyBroadcast({ ...base, authMode: 'anonymous' }, 'token')).toBe(false)
  })

  test('NEVER applies another tab\u2019s auth rejection \u2014 tokens are per-tab', () => {
    // Tab A and tab B both hold a token. B\u2019s token was rejected and B
    // broadcasts auth-rejected. A\u2019s token is fine; applying B\u2019s
    // outcome would clear A\u2019s valid token and cache.
    const rejected = {
      type: 'cycle',
      authMode: 'token' as const,
      outcome: { status: 'auth-rejected' },
    }
    expect(shouldApplyBroadcast(rejected, 'token')).toBe(false)
    // Anonymous tab never sees token-mode broadcasts anyway:
    expect(shouldApplyBroadcast(rejected, 'anonymous')).toBe(false)
  })

  test('non-cycle and malformed messages are ignored, never crash', () => {
    expect(shouldApplyBroadcast(null, 'anonymous')).toBe(false)
    expect(shouldApplyBroadcast(undefined, 'token')).toBe(false)
    expect(shouldApplyBroadcast('cycle', 'anonymous')).toBe(false)
    expect(shouldApplyBroadcast({ type: 'other' }, 'anonymous')).toBe(false)
    expect(shouldApplyBroadcast({ type: 'cycle' }, 'anonymous')).toBe(false)
    expect(shouldApplyBroadcast({ type: 'cycle', authMode: 'token' }, 'token')).toBe(false)
  })
})
