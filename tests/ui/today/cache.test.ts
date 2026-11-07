import { describe, expect, test } from 'bun:test'
import {
  baselineForNextSave,
  isUsableBaseline,
  rollBaseline,
  rollRetained,
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
  /** When true, put() requests fail — reads keep working. */
  failPuts = false

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
                if (self.failPuts) {
                  req.onerror?.({ target: { error: new Error('QuotaExceededError') } })
                  queueMicrotask(() => tx.onabort?.())
                  return
                }
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
    checksStoppedReason: null,
    missingChecks: [],
    prs: [],
    ...overrides,
  }
}

const H = 60 * 60 * 1000

function pair(current: TodaySnapshot | null, baseline: TodaySnapshot | null, retained: TodaySnapshot | null = null): CachePair {
  return { current, baseline, retained }
}
const at = (hoursAgo: number) => new Date(Date.parse('2026-11-08T12:00:00Z') - hoursAgo * H).toISOString()

describe('rollBaseline — pure rotation logic', () => {
  const next = snap({ collectedAt: at(0) })

  test('empty cache: no rotation candidate', () => {
    expect(rollBaseline(pair(null, null), next)).toBeNull()
  })

  test('young previous current (3h) keeps the existing baseline', () => {
    const prev: CachePair = pair(snap({ collectedAt: at(3) }), snap({ collectedAt: at(30) }))
    expect(rollBaseline(prev, next)).toBe(prev.baseline)
  })

  test('previous current ≥ 20h old is promoted to baseline', () => {
    const prev: CachePair = pair(snap({ collectedAt: at(21) }), snap({ collectedAt: at(30) }))
    expect(rollBaseline(prev, next)).toBe(prev.current)
  })

  test('baseline beyond 48h rotates to a ≥ 12h current', () => {
    const prev: CachePair = pair(snap({ collectedAt: at(13) }), snap({ collectedAt: at(50) }))
    expect(rollBaseline(prev, next)).toBe(prev.current)
  })

  test('stale baseline with a too-young current is kept (no honest candidate)', () => {
    const prev: CachePair = pair(snap({ collectedAt: at(5) }), snap({ collectedAt: at(50) }))
    expect(rollBaseline(prev, next)).toBe(prev.baseline)
  })

  test('cross-auth cache slots are never kept or promoted', () => {
    // A token-derived baseline must not become an anonymous session's
    // baseline (visibility differs → fabricated queue changes; and it would
    // keep token-only data on disk past its session).
    const prev: CachePair = pair(
      snap({ collectedAt: at(21), authMode: 'token' }),
      snap({ collectedAt: at(50), authMode: 'token' }),
    )
    expect(rollBaseline(prev, { ...next, authMode: 'anonymous' })).toBeNull()
    // Mixed slots: the anonymous current is promotable, the token baseline is not kept.
    const mixed: CachePair = pair(
      snap({ collectedAt: at(21), authMode: 'anonymous' }),
      snap({ collectedAt: at(30), authMode: 'token' }),
    )
    expect(rollBaseline(mixed, { ...next, authMode: 'anonymous' })).toBe(mixed.current)
  })

  test('continuous user: baseline eventually rotates via the retained slot', () => {
    // A user who keeps the page open saves every 3h; `current` is always
    // ~3h old, so without a retained slot the 12h rotate gate could never
    // fire and the baseline would stay frozen at first-ever collection.
    // Simulate: seed at t0, then 3h saves; retained keeps t0 (oldest, within
    // 48h) until it ages out, then follows the window.
    const t0 = snap({ collectedAt: at(63) })
    const early = snap({ collectedAt: at(60) }) // 3h after t0 — becomes retained
    const now = snap({ collectedAt: at(0) }) // 63h after t0

    // Baseline is t0 (63h old → beyond the 48h window), retained is `early`
    // (60h old — also beyond the window), current is `now` (3h old, too
    // young): no candidate inside the window → keep the old baseline.
    const tooOldRetained: CachePair = pair(now, t0, early)
    expect(rollBaseline(tooOldRetained, now)).toBe(t0)

    // Retained inside the window and >= 12h old → rotation fires.
    const midRetained: CachePair = pair(now, t0, snap({ collectedAt: at(13) }))
    expect(rollBaseline(midRetained, now)).toBe(midRetained.retained)

    // Current itself qualifies (>= 12h, within window) when retained does not.
    const oldCurrent: CachePair = pair(snap({ collectedAt: at(15) }), t0, null)
    expect(rollBaseline(oldCurrent, now)).toBe(oldCurrent.current)
  })
})

describe('rollRetained — oldest same-auth complete snapshot within the window', () => {
  const next = { collectedAt: at(0), authMode: 'anonymous' as const }

  test('keeps the older retained snapshot; a newer current never displaces it', () => {
    const prev: CachePair = pair(snap({ collectedAt: at(3) }), snap({ collectedAt: at(30) }), snap({ collectedAt: at(20) }))
    expect(rollRetained(prev, next)).toBe(prev.retained) // 20h old beats the 3h current
  })

  test('empty retained slot adopts the previous current', () => {
    const prev: CachePair = pair(snap({ collectedAt: at(3) }), snap({ collectedAt: at(30) }), null)
    expect(rollRetained(prev, next)).toBe(prev.current)
  })

  test('retained beyond the retention window rolls to the previous current', () => {
    const prev: CachePair = pair(snap({ collectedAt: at(3) }), snap({ collectedAt: at(60) }), snap({ collectedAt: at(55) }))
    expect(rollRetained(prev, next)).toBe(prev.current) // 55h > 48h window
  })

  test('cross-auth retained/current are never retained for the next session', () => {
    const prev: CachePair = pair(
      snap({ collectedAt: at(3), authMode: 'token' }),
      snap({ collectedAt: at(30) }),
      snap({ collectedAt: at(20), authMode: 'token' }),
    )
    expect(rollRetained(prev, { ...next, authMode: 'anonymous' })).toBeNull()
  })

  test('end-to-end save sequence: rotation actually fires for a continuous user', async () => {
    const idb = new MockIdb()
    const cache = new TodayCache(idb)
    // t0 seed; then saves at 60h..0h (3h apart) like a page open for ~2.5 days.
    await cache.saveComplete(snap({ collectedAt: at(63) }))
    for (let h = 60; h >= 0; h -= 3) {
      await cache.saveComplete(snap({ collectedAt: at(h) }))
    }
    const loaded = await cache.load()
    // The baseline must not still be the t0 snapshot (63h old): the retained
    // slot (a snapshot 12-48h old at some save) rotated it forward.
    expect(loaded.baseline?.collectedAt).not.toBe(at(63))
    const baselineAge = (Date.parse(at(0)) - Date.parse(loaded.baseline?.collectedAt ?? '')) / H
    expect(baselineAge).toBeGreaterThan(0)
    expect(baselineAge).toBeLessThanOrEqual(48)
  })
})

describe('baselineForNextSave — the baseline missing-PR checks must run against', () => {
  const next = { collectedAt: at(0), authMode: 'anonymous' as const }

  test('mirrors rollBaseline when a rotation candidate exists', () => {
    const prev: CachePair = pair(snap({ collectedAt: at(21) }), snap({ collectedAt: at(30) }))
    expect(baselineForNextSave(prev, next)).toBe(prev.current)
  })

  test('no candidate: the next save seeds with itself — an empty diff, no checks needed', () => {
    const preview = baselineForNextSave(pair(null, null), next)
    expect(preview).not.toBeNull()
    expect(preview?.prs).toEqual([])
    expect(preview?.collectedAt).toBe(next.collectedAt)
    // diff against the snapshot about to be saved = empty everywhere
  })

  test('cross-auth cache: empty preview — token slots never checked against anonymous saves', () => {
    const prev: CachePair = pair(
      snap({ collectedAt: at(21), authMode: 'token' }),
      snap({ collectedAt: at(50), authMode: 'token' }),
    )
    const preview = baselineForNextSave(prev, { ...next, authMode: 'anonymous' })
    expect(preview?.prs).toEqual([])
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

    const second = snap({ collectedAt: at(0), prs: [{ repo: 'MetaMask/core', number: 5, title: 'x', url: 'https://github.com/MetaMask/core/pull/5', author: 'a', draft: false, createdAt: at(1), updatedAt: at(1), labels: [], requestedTeams: [], requestedReviewers: [] }] })
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

  test('clearAll wipes all three slots — token-derived data never survives (auth change)', async () => {
    const idb = new MockIdb()
    const cache = new TodayCache(idb)
    await cache.saveComplete(snap({ collectedAt: at(3), authMode: 'token' }))
    await cache.saveComplete(snap({ collectedAt: at(0), authMode: 'token' }))
    // Second save populated the retained slot; all three slots are non-null.
    expect((await cache.load()).retained).not.toBeNull()
    await cache.clearAll()
    expect(await cache.load()).toEqual(pair(null, null, null))
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
    expect(idb.puts.map((p) => p.key).sort()).toEqual(['baseline', 'current']) // seed save: retained slot is empty (deleted, not put)
    for (const put of idb.puts) {
      const serialized = JSON.stringify(put.value)
      expect(serialized).not.toContain('authorization')
      expect(serialized).not.toContain('Bearer')
      expect(serialized).not.toContain('github_pat_')
      expect(serialized).not.toContain('ghp_')
      expect(Object.keys(put.value as Record<string, unknown>).sort()).toEqual([
        'authMode',
        'checksStoppedReason',
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

  test('clean IDB miss falls through to the memory tier (degraded writes stay readable)', async () => {
    // Regression: a get() that resolves undefined (clean miss) used to skip
    // the memory tier entirely, so a session whose IndexedDB writes failed
    // (quota, private mode) could not read back the data its own in-memory
    // tier still held — the view went blank for the rest of the session.
    const idb = new MockIdb()
    idb.failPuts = true // writes fail; reads keep resolving
    const cache = new TodayCache(idb)
    const saved = snap({ collectedAt: at(0) })
    await cache.saveComplete(saved) // write fails → memory tier + degraded
    // `persistent` just means "IDB configured"; `operational` reports the
    // session-degraded state the UI surfaces.
    expect(cache.persistent).toBe(true)
    expect(cache.operational).toBe(false)
    // Same session, same client: load() must surface the memory tier even
    // though every IDB get() cleanly misses (resolves undefined).
    const loaded = await cache.load()
    expect(loaded.current).toEqual(saved)
    // Seed-with-self semantics are preserved through the memory tier.
    expect(loaded.baseline).toEqual(saved)
    expect(loaded.retained).toBeNull()
  })

  test('IndexedDB open failure marks the session degraded (UI can say so)', async () => {
    // A blocked/corrupted open must not masquerade as a healthy persistent
    // cache: nothing will survive a reload, and operational === false lets
    // the UI surface that honestly.
    const broken: IdbLike = {
      open: () => {
        const req: ReqLike = { onsuccess: null, onerror: null }
        queueMicrotask(() => req.onerror?.({ target: { error: new Error('VersionError') } }))
        return req
      },
    }
    const cache = new TodayCache(broken)
    const pair = await cache.saveComplete(snap({ collectedAt: at(0) }))
    expect(pair.current).toEqual(snap({ collectedAt: at(0) })) // memory tier worked
    expect(cache.persistent).toBe(true) // IDB is configured…
    expect(cache.operational).toBe(false) // …but known-degraded this session
    expect((await cache.load()).current).toEqual(snap({ collectedAt: at(0) }))
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
