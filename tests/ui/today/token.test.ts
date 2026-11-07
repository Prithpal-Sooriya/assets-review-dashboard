import { describe, expect, test } from 'bun:test'
import {
  clearToken,
  currentEpoch,
  getToken,
  scrubSecrets,
  scrubToken,
  scrubTokenShapes,
  setToken,
} from '../../../src/today/token'

describe('memory-only token store', () => {
  test('set/get/clear round-trip', () => {
    clearToken()
    expect(getToken()).toBeNull()
    setToken('github_pat_TESTTOKEN1234')
    expect(getToken()).toBe('github_pat_TESTTOKEN1234')
    clearToken()
    expect(getToken()).toBeNull()
  })

  test('whitespace-only input is treated as clear', () => {
    setToken('github_pat_REAL1')
    const epoch = setToken('   ')
    expect(getToken()).toBeNull()
    expect(epoch).toBeGreaterThan(0)
    clearToken()
  })

  test('every auth change bumps the epoch (in-flight results become stale)', () => {
    clearToken()
    const e0 = currentEpoch()
    const e1 = setToken('github_pat_ABCDEFGH')
    const e2 = setToken('github_pat_DIFFERENT')
    const e3 = clearToken()
    expect(e1).toBe(e0 + 1)
    expect(e2).toBe(e1 + 1)
    expect(e3).toBe(e2 + 1)
    expect(currentEpoch()).toBe(e3)
  })
})

describe('secret scrubbing', () => {
  test('scrubToken removes the live token exactly', () => {
    clearToken()
    setToken('github_pat_SUPERSECRET_VALUE_42')
    const text = 'Request to api.github.com with github_pat_SUPERSECRET_VALUE_42 failed'
    expect(scrubToken(text)).toBe('Request to api.github.com with [redacted] failed')
    clearToken()
  })

  test('scrubToken is a no-op with no token loaded', () => {
    clearToken()
    expect(scrubToken('nothing to scrub')).toBe('nothing to scrub')
  })

  test('scrubTokenShapes masks token-shaped strings even without a loaded token', () => {
    clearToken()
    expect(scrubTokenShapes('leak: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456')).toBe('leak: [redacted]')
    expect(scrubTokenShapes('leak: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456')).toBe('leak: [redacted]')
    expect(scrubTokenShapes('leak: github_pat_11ABCDEFG0_short')).toBe('leak: [redacted]')
    // Ordinary text and short non-tokens are untouched.
    expect(scrubTokenShapes('ghp_short')).toBe('ghp_short')
    expect(scrubTokenShapes('plain text')).toBe('plain text')
  })

  test('scrubSecrets composes both scrubs', () => {
    clearToken()
    setToken('github_pat_LIVE_ONE')
    const text = 'err with github_pat_LIVE_ONE and echo gho_ABCDEFGHIJKLMNO1234567890'
    expect(scrubSecrets(text)).toBe('err with [redacted] and echo [redacted]')
    clearToken()
  })

  test('error-serialization regression: common error shapes stay clean', () => {
    clearToken()
    setToken('ghp_LIVE1234567890abcdefghij')
    const fakeError = new Error('HTTP 403 for https://api.github.com/repositories/1/pulls')
    const serialized = JSON.stringify({
      message: scrubSecrets(fakeError.message),
      name: fakeError.name,
    })
    expect(serialized).not.toContain('ghp_LIVE1234567890abcdefghij')
    clearToken()
  })
})
