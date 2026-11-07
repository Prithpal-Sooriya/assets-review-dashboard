/**
 * IndexedDB cache for the Today view: the last complete normalized snapshot
 * ("current") and a suitable prior snapshot ("baseline") for the
 * since-yesterday comparison.
 *
 * Invariants (unit-tested):
 *  - Only public snapshot data is stored — never request headers, never the
 *    token, never raw API responses.
 *  - "current" is only ever a COMPLETE snapshot: failed or partial sweeps
 *    never overwrite the last good data.
 *  - The baseline rotates to a previous current only once it is old enough
 *    (≥ BASELINE_MIN_AGE_MS, with a max-age fallback), and always carries its
 *    real timestamp — the UI labels it with that actual time, never "yesterday".
 *  - Auth-mode changes clear the whole cache: visibility differs between
 *    anonymous and token collection, so mixing snapshots across auth modes
 *    would fabricate queue changes.
 */

import {
  BASELINE_MAX_AGE_MS,
  BASELINE_MIN_AGE_MS,
  BASELINE_ROTATE_MIN_AGE_MS,
  CACHE_DB_NAME,
  CACHE_DB_VERSION,
  CACHE_KEY_BASELINE,
  CACHE_KEY_CURRENT,
  CACHE_STORE,
} from './config'
import { isTodaySnapshot, type TodaySnapshot } from './normalize'

export interface CachePair {
  current: TodaySnapshot | null
  baseline: TodaySnapshot | null
}

/**
 * Pure baseline rotation. Given the previous cache state and a NEW COMPLETE
 * snapshot, decide the next baseline:
 *  - promote the previous current when it is at least BASELINE_MIN_AGE_MS old
 *    (the "since yesterday" case after the page was closed ~a day), or
 *  - when the existing baseline has drifted beyond BASELINE_MAX_AGE_MS and
 *    the previous current is at least BASELINE_ROTATE_MIN_AGE_MS old, rotate
 *    to it so continuous users eventually get a fresher (still old, still
 *    honestly timestamped) baseline;
 *  - otherwise keep the existing baseline.
 */
export function rollBaseline(
  prev: CachePair,
  nextComplete: TodaySnapshot,
): TodaySnapshot | null {
  const nextAt = Date.parse(nextComplete.collectedAt)
  const ageOf = (snap: TodaySnapshot | null): number | null => {
    if (snap === null) return null
    const t = Date.parse(snap.collectedAt)
    return Number.isNaN(t) ? null : nextAt - t
  }
  const currentAge = ageOf(prev.current)
  const baselineAge = ageOf(prev.baseline)

  if (currentAge !== null && currentAge >= BASELINE_MIN_AGE_MS) {
    return prev.current
  }
  if (
    baselineAge !== null &&
    baselineAge > BASELINE_MAX_AGE_MS &&
    currentAge !== null &&
    currentAge >= BASELINE_ROTATE_MIN_AGE_MS
  ) {
    return prev.current
  }
  return prev.baseline
}

/** Minimal async surface over IndexedDB; injectable for tests. */
export interface IdbLike {
  open(name: string, version: number): IdbRequestLike<IDbDatabaseLike>
}

export interface IdbRequestLike<T> {
  onsuccess: ((event: { target: { result: T } }) => void) | null
  onerror: ((event: { target: { error: unknown } }) => void) | null
  onupgradeneeded?: ((event: { target: { result: IDbDatabaseLike } }) => void) | null
}

export interface IDbDatabaseLike {
  transaction(store: string, mode: 'readonly' | 'readwrite'): IDbTransactionLike
  close(): void
}

export interface IDbTransactionLike {
  objectStore(store: string): IDbObjectStoreLike
  oncomplete: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
}

export interface IDbObjectStoreLike {
  get(key: string): IdbRequestLike<unknown>
  put(value: unknown, key: string): IdbRequestLike<unknown>
  delete(key: string): IdbRequestLike<unknown>
  clear(): IdbRequestLike<unknown>
}

function requestToPromise<T>(req: IdbRequestLike<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = (event) => resolve(event.target.result)
    req.onerror = (event) => reject(event.target.error ?? new Error('IndexedDB request failed'))
  })
}

/**
 * Cache client. `idb` defaults to the global indexedDB; when unavailable
 * (or any operation fails) the client degrades to in-memory no-ops so the
 * page still works — it just loses persistence, which the UI states.
 */
export class TodayCache {
  private dbPromise: Promise<IDbDatabaseLike> | null
  private memory = new Map<string, TodaySnapshot>()
  readonly persistent: boolean

  constructor(idb: IdbLike | null) {
    this.persistent = idb !== null
    this.dbPromise = idb !== null ? this.openDb(idb) : null
  }

  private openDb(idb: IdbLike): Promise<IDbDatabaseLike> {
    return new Promise((resolve, reject) => {
      const req = idb.open(CACHE_DB_NAME, CACHE_DB_VERSION)
      req.onupgradeneeded = (event) => {
        // Real IndexedDB creates the store here; test mocks may pre-create it.
        const db = event.target.result as IDbDatabaseLike & {
          createObjectStore?: (name: string) => unknown
        }
        db.createObjectStore?.(CACHE_STORE)
      }
      req.onsuccess = (event) => {
        const db = event.target.result
        try {
          db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE)
        } catch {
          // Store missing (schema drift): treat persistence as unavailable.
          reject(new Error('cache store missing'))
          return
        }
        resolve(db)
      }
      req.onerror = (event) => reject(event.target.error ?? new Error('IndexedDB open failed'))
    })
  }

  private async withStore<T>(
    mode: 'readonly' | 'readwrite',
    op: (store: IDbObjectStoreLike) => Promise<T>,
  ): Promise<T | null> {
    if (this.dbPromise === null) return null
    let db: IDbDatabaseLike
    try {
      db = await this.dbPromise
    } catch {
      this.dbPromise = null
      return null
    }
    return new Promise<T | null>((resolve) => {
      let result: T | null = null
      let failed = false
      const tx = db.transaction(CACHE_STORE, mode)
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => resolve(null)
      tx.onabort = () => resolve(null)
      op(tx.objectStore(CACHE_STORE))
        .then((value) => {
          result = value
        })
        .catch(() => {
          failed = true
          void failed
          resolve(null)
        })
    })
  }

  private async readKey(key: string): Promise<TodaySnapshot | null> {
    const fromDb = await this.withStore('readonly', (store) =>
      requestToPromise(store.get(key)),
    )
    const raw = fromDb !== null ? fromDb : (this.memory.get(key) ?? null)
    return isTodaySnapshot(raw) ? raw : null
  }

  private async writeKey(key: string, snap: TodaySnapshot): Promise<void> {
    this.memory.set(key, snap)
    await this.withStore('readwrite', (store) => requestToPromise(store.put(snap, key)))
  }

  async load(): Promise<CachePair> {
    if (!this.persistent) {
      return {
        current: this.readMemory(CACHE_KEY_CURRENT),
        baseline: this.readMemory(CACHE_KEY_BASELINE),
      }
    }
    const [current, baseline] = await Promise.all([
      this.readKey(CACHE_KEY_CURRENT),
      this.readKey(CACHE_KEY_BASELINE),
    ])
    return { current, baseline }
  }

  private readMemory(key: string): TodaySnapshot | null {
    const raw = this.memory.get(key) ?? null
    return isTodaySnapshot(raw) ? raw : null
  }

  /**
   * Persist a newly collected COMPLETE snapshot: rotate the baseline first
   * (using the previous pair), then overwrite current.
   */
  async saveComplete(next: TodaySnapshot): Promise<CachePair> {
    if (!next.complete) throw new Error('refusing to cache an incomplete snapshot')
    const prev = await this.load()
    const rotated = rollBaseline(prev, next)
    // If no old-enough baseline exists yet, seed the slot with the newest
    // complete snapshot so future rotations always have a candidate. The
    // isUsableBaseline gate keeps the UI from presenting a too-young
    // baseline as a "since yesterday" comparison.
    const baseline = rotated ?? next
    await this.writeKey(CACHE_KEY_BASELINE, baseline)
    await this.writeKey(CACHE_KEY_CURRENT, next)
    return { current: next, baseline }
  }

  /** Auth-mode change or token change: drop all cached snapshots. */
  async clearAll(): Promise<void> {
    this.memory.clear()
    await this.withStore('readwrite', (store) => requestToPromise(store.clear()))
  }
}

/**
 * A baseline is usable when complete, same-auth, and old enough to be
 * meaningful but not ancient (at least BASELINE_MIN_AGE_MS, at most a week).
 * A null `current` (nothing cached yet) is treated as anonymous — the auth a
 * fresh collection will use.
 */
export function isUsableBaseline(
  baseline: TodaySnapshot | null,
  current: TodaySnapshot | null,
  nowMs: number,
): boolean {
  if (baseline === null) return false
  if (!baseline.complete) return false
  if (current !== null && baseline.authMode !== current.authMode) return false
  if (current === null && baseline.authMode !== 'anonymous') return false
  const at = Date.parse(baseline.collectedAt)
  if (Number.isNaN(at)) return false
  const age = nowMs - at
  return age >= BASELINE_MIN_AGE_MS && age <= 7 * 24 * 60 * 60 * 1000
}
