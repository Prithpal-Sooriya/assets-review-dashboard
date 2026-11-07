import { describe, expect, test } from 'bun:test'
import {
  applyHash,
  buildTodayHash,
  DEFAULT_TODAY_STATE,
  parseHash,
} from '../../../src/today/urlstate'

describe('Today URL state round-trips', () => {
  test('defaults with no params', () => {
    expect(parseHash('#/today')).toEqual(DEFAULT_TODAY_STATE)
  })

  test('every filter round-trips through build/parse', () => {
    const state = {
      view: 'awaiting',
      repo: 'MetaMask/metamask-extension',
      author: 'external',
      group: 'team',
      sort: 'newest',
    } as const
    const hash = buildTodayHash(state)
    expect(hash).toBe('#/today?view=awaiting&repo=MetaMask%2Fmetamask-extension&author=external&group=team&sort=newest')
    expect(parseHash(hash)).toEqual(state)
  })

  test('unknown repo values fall back to null (never invented)', () => {
    expect(parseHash('#/today?repo=MetaMask%2Fnot-a-repo').repo).toBeNull()
    expect(parseHash('#/today?repo=https%3A%2F%2Fevil').repo).toBeNull()
  })

  test('invalid enum values fall back to defaults', () => {
    const state = parseHash('#/today?view=bogus&sort=bogus&group=bogus&author=bogus')
    expect(state).toEqual(DEFAULT_TODAY_STATE)
  })

  test('default-valued params are omitted from the hash (shareable, minimal)', () => {
    const hash = buildTodayHash({ ...DEFAULT_TODAY_STATE, view: 'needs' })
    expect(hash).toBe('#/today?view=needs')
  })

})

describe('applyHash', () => {
  test('no-ops when the hash is already current (no history spam)', () => {
    // Minimal window mock: bun test has no DOM.
    const calls: unknown[][] = []
    const fakeLocation = { hash: '#/today?view=needs' }
    const fakeHistory = {
      replaceState: (...args: unknown[]) => {
        calls.push(args)
        fakeLocation.hash = String(args[2] ?? fakeLocation.hash)
      },
    }
    const prevWindow = (globalThis as Record<string, unknown>).window
    const prevHistory = (globalThis as Record<string, unknown>).history
    const prevLocation = (globalThis as Record<string, unknown>).location
    ;(globalThis as Record<string, unknown>).window = { history: fakeHistory, location: fakeLocation }
    ;(globalThis as Record<string, unknown>).history = fakeHistory
    ;(globalThis as Record<string, unknown>).location = fakeLocation
    try {
      applyHash('#/today?view=needs')
      expect(calls.length).toBe(0)
      applyHash('#/today?view=awaiting')
      expect(calls.length).toBe(1)
      expect(fakeLocation.hash).toBe('#/today?view=awaiting')
    } finally {
      ;(globalThis as Record<string, unknown>).window = prevWindow
      ;(globalThis as Record<string, unknown>).history = prevHistory
      ;(globalThis as Record<string, unknown>).location = prevLocation
    }
  })
})
