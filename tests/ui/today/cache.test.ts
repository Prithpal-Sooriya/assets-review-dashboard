import { describe, expect, test } from 'bun:test'
import {
  isUsableBaseline,
  rollBaseline,
  TodayCache,
  type CachePair,
  type IdbLike,
} from '../../../src/today/cache'
import type { TodaySnapshot } from '../../../src/today/normalize'

/* ------------------------------------------------------------------ */
/* Minimal in-memory IndexedDB mock implementing only the surface the  */
/* cache uses. Records every put() so tests can inspect EXACTLY what  */
/* would be persisted.                                                */
/* ------------------------------------------------------------------ */

type ReqLike = {
  onsuccess: ((e: { target: { result: unknown } }) => void) | null
  onerror: ((e: { target: { error: unknown } }) => void) | null
}

class MockIdb implements IdbLike {
  stores = new Map<string, Map<string, unknown>>()
  puts: { key: string; value: unknown }[] = []

  open(name: string, _version: number) {
    const req: {
      onsuccess: ((e: { target: { result: unknown } }) => void) | null
      onerror: ((e: { target: { error: unknown } }) => void) | null
      onupgradeneeded?: ((e: { target: { result: unknown } }) => void) | null
    } = { onsuccess: null, onerror: null }
    queueMicrotask(() => {
      req.onupgradeneeded?.({ target: { result: this.dbLike() } })
      // Ensure the store exists (real IDB would create it in upgrade).
      this.stores.set('snapshots', this.stores.get('snapshots') ?? new Map())
      req.onsuccess?.({ target: { result: this.dbLike() } })
    })
    return req
  }

  private dbLike() {
    const self = this
    return {
      transaction(store: string, _mode: 'readonly' | 'readwrite') {
        const map = self.stores.get(store) ?? self.stores.set(store, new Map()).get(store)!
        const tx: {
          oncomplete: (() => void) | null
          onerror: (() => void) | null
          onabort: (() => void) | null
          objectStore: () => {
            get: (key: string) => unknown
            put: (value: unknown, key: string) => unknown
            delete: (key: string) => unknown
            clear: () => unknown
          }
        } = {
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore: () => ({
            get: (key: string) => {
              const req: ReqLike = { onsuccess: null, onerror: null }
              // onsuccess first, then oncomplete strictly after the caller's
              // .then chain has stored the result (real IDB ordering).
              queueMicrotask(() => {
                req.onsuccess?.({ target: { result: map.get(key) } })
                queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()))
              })
              return req
            },
            put: (value: unknown, key: string) => {
              self.puts.push({ key, value })
              const req: ReqLike = { onsuccess: null, onerror: null }
              queueMicrotask(() => {
                map.set(key, value)
                req.onsuccess?.({ target: { result: undefined } })
                queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()))
              })
              return req
            },
            delete: (key: string) => {
              const req: ReqLike = { onsuccess: null, onerror: null }
              queueMicrotask(() => {
                map.delete(key)
                req.onsuccess?.({ target: { result: undefined } })
                queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()))
              })
              return req
            },
            clear: () => {
              const req: ReqLike = { onsuccess: null, onerror: null }
              queueMicrotask(() => {
                map.clear()
                req.onsuccess?.({ target: { result: undefined } })
                queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()))
              })
              return req
            },
          }),
        }
        return tx
      },
      close: () => {},
    }
  }
}

function snap(overrides: Partial<TodaySnapshot> = {}): TodaySnapshot {
  return {
    schemaVersion: 1,
    collectedAt: '2026-11-08T12:00:00Z',
    authMode: 'anonymous',
    repos: [],
    complete: true,
    partialReason: null,
    rate: null,
    droppedMalformed: 0,
    missingChecks: [],
    prs: [],
    ...overrides,
  }
}

const H = 60 * 60 * 1000
const at = (hoursAgo: number) => new Date(Date.parse('2026-11-08T12:00:00Z') - hoursAgo * H).toISOString()

describe('rollBaseline — pure rotation logic', () => {
  const next = snap({ collectedAt: at(0) })

  test('empty cache: no rotation candidate', () => {
    expect(rollBaseline({ current: null, baseline: null }, next)).toBeNull()
  })

  test('young previous current (3h) keeps the existing baseline', () => {
    const prev: CachePair = { current: snap({ collectedAt: at(3) }), baseline: snap({ collectedAt: at(30) }) }
    expect(rollBaseline(prev, next)).toBe(prev.baseline)
  })

  test('previous current ≥ 20h old is promoted to baseline', () => {
    const prev: CachePair = { current: snap({ collectedAt: at(21) }), baseline: snap({ collectedAt: at(30) }) }
    expect(rollBaseline(prev, next)).toBe(prev.current)
  })

  test('baseline beyond 48h rotates to a ≥ 12h current', () => {
    const prev: CachePair = { current: snap({ collectedAt: at(13) }), baseline: snap({ collectedAt: at(50) }) }
    expect(rollBaseline(prev, next)).toBe(prev.current)
  })

  test('stale baseline with a too-young current is kept (no honest candidate)', () => {
    const prev: CachePair = { current: snap({ collectedAt: at(5) }), baseline: snap({ collectedAt: at(50) }) }
    expect(rollBaseline(prev, next)).toBe(prev.baseline)
  })
})

describe('isUsableBaseline — since-yesterday honesty gate', () => {
  const NOW = Date.parse('2026-11-08T12:00:00Z')
  const current = snap({ collectedAt: at(0), authMode: 'anonymous' })

  test('null or incomplete baselines are unusable', () => {
    expect(isUsableBaseline(null, current, NOW)).toBe(false)
    expect(isUsableBaseline(snap({ complete: false, collectedAt: at(30) }), current, NOW)).toBe(false)
  })

  test('auth-mode mismatch is unusable (visibility differs)', () => {
    expect(isUsableBaseline(snap({ collectedAt: at(30), authMode: 'token' }), current, NOW)).toBe(false)
  })

  test('null current (nothing cached yet) is treated as anonymous', () => {
    // Fresh mount, seeded baseline, no current snapshot: an anonymous
    // collection can still use the baseline for missing-PR checks.
    expect(isUsableBaseline(snap({ collectedAt: at(30) }), null, NOW)).toBe(true)
    // A token-derived baseline is NOT usable for an anonymous fresh start.
    expect(isUsableBaseline(snap({ collectedAt: at(30), authMode: 'token' }), null, NOW)).toBe(false)
  })

  test('age window: ≥ 20h and ≤ 7d', () => {
    expect(isUsableBaseline(snap({ collectedAt: at(19) }), current, NOW)).toBe(false)
    expect(isUsableBaseline(snap({ collectedAt: at(20) }), current, NOW)).toBe(true)
    expect(isUsableBaseline(snap({ collectedAt: at(24) }), current, NOW)).toBe(true)
    expect(isUsableBaseline(snap({ collectedAt: at(7 * 24 + 1) }), current, NOW)).toBe(false)
  })

  test('unparseable timestamp is unusable', () => {
    expect(isUsableBaseline(snap({ collectedAt: 'garbage' }), current, NOW)).toBe(false)
  })
})

describe('TodayCache — persistence', () => {
  test('saveComplete seeds then rotates the baseline; load round-trips', async () => {
    const idb = new MockIdb()
    const cache = new TodayCache(idb)
    const first = snap({ collectedAt: at(24) })
    const seeded = await cache.saveComplete(first)
    expect(seeded.baseline).toEqual(first) // seed: no old-enough baseline yet
    expect(seeded.current).toEqual(first)

    const second = snap({ collectedAt: at(0), prs: [{ repo: 'MetaMask/core', number: 5, title: 'x', url: 'u', author: 'a', draft: false, createdAt: at(1), updatedAt: at(1), labels: [], requestedTeams: [], requestedReviewers: [] }] })
    const pair = await cache.saveComplete(second)
    expect(pair.current).toEqual(second)
    expect(pair.baseline).toEqual(first) // first is 24h old → promoted on the NEXT save

    const loaded = await cache.load()
    expect(loaded.current).toEqual(second)
    expect(loaded.baseline).toEqual(first)
  })

  test('partial snapshots are never cached (last good data preserved)', async () => {
    const idb = new MockIdb()
    const cache = new TodayCache(idb)
    const good = snap({ collectedAt: at(0) })
    await cache.saveComplete(good)
    const partial = snap({ complete: false, partialReason: 'page-cap', collectedAt: at(0), prs: [] })
    await expect(cache.saveComplete(partial)).rejects.toThrow(/incomplete/i)
    const loaded = await cache.load()
    expect(loaded.current).toEqual(good)
  })

  test('clearAll wipes both slots (auth change)', async () => {
    const idb = new MockIdb()
    const cache = new TodayCache(idb)
    await cache.saveComplete(snap({ collectedAt: at(0) }))
    await cache.clearAll()
    expect(await cache.load()).toEqual({ current: null, baseline: null })
    expect(idb.puts.length).toBeGreaterThan(0)
  })

  test('persisted records contain ONLY public snapshot fields — no token, no auth headers', async () => {
    const idb = new MockIdb()
    const cache = new TodayCache(idb)
    const withRate = snap({
      collectedAt: at(0),
      rate: { limit: 60, remaining: 55, reset: '2026-11-08T13:00:00Z' },
    })
    await cache.saveComplete(withRate)
    expect(idb.puts.length).toBe(2) // baseline + current
    for (const put of idb.puts) {
      const serialized = JSON.stringify(put.value)
      expect(serialized).not.toContain('authorization')
      expect(serialized).not.toContain('Bearer')
      expect(serialized).not.toContain('github_pat_')
      expect(serialized).not.toContain('ghp_')
      expect(Object.keys(put.value as Record<string, unknown>).sort()).toEqual([
        'authMode',
        'collectedAt',
        'complete',
        'droppedMalformed',
        'missingChecks',
        'partialReason',
        'prs',
        'rate',
        'repos',
        'schemaVersion',
      ])
    }
  })

  test('corrupted stored records are rejected on load, not rendered', async () => {
    const idb = new MockIdb()
    const cache = new TodayCache(idb)
    await cache.saveComplete(snap({ collectedAt: at(0) }))
    // Corrupt the durable store directly (simulating tampering/drift), then
    // load through a fresh client so the in-memory tier cannot mask it.
    idb.stores.get('snapshots')!.set('current', { schemaVersion: 99, prs: 'garbage' })
    idb.stores.get('snapshots')!.set('baseline', null)
    const fresh = new TodayCache(idb)
    const loaded = await fresh.load()
    expect(loaded.current).toBeNull()
    expect(loaded.baseline).toBeNull()
  })

  test('no IndexedDB: degrades to in-memory (persistent=false), still functional', async () => {
    const cache = new TodayCache(null)
    expect(cache.persistent).toBe(false)
    const s = snap({ collectedAt: at(0) })
    const pair = await cache.saveComplete(s)
    expect(pair.current).toEqual(s)
    const loaded = await cache.load()
    expect(loaded.current).toEqual(s)
    await cache.clearAll()
    expect((await cache.load()).current).toBeNull()
  })
})
