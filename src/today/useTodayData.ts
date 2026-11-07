/**
 * React glue for the Today view: cache-first paint, stale-triggered
 * collection, cross-tab coordination, auth transitions, backoff.
 *
 * Behavioral contract (e2e-tested; pure decisions unit-tested in
 * cycle-controller.ts):
 *  - On mount: paint the IndexedDB cache immediately, then collect only if
 *    the cache is missing/stale (reopen uses cache first).
 *  - While the page is open, a 5-minute tick refreshes when the snapshot is
 *    older than REFRESH_INTERVAL_MS (3h). No collection ever happens with
 *    the page closed; the UI says so rather than implying background work.
 *  - Only one tab collects at a time (Web Locks); outcomes broadcast to
 *    other tabs, which apply them only when the auth mode matches their own
 *    and never apply another tab's auth rejection (tokens are per-tab).
 *  - Auth transitions (Use token / Clear) abort in-flight cycles, clear all
 *    auth-derived cached data, and immediately recollect — waiting for the
 *    cross-tab lock if another tab holds it, so the collection is never
 *    silently dropped; results collected under a superseded auth epoch are
 *    discarded, never published.
 *  - Failed cycles never overwrite the last good cached snapshot; retries
 *    follow the backoff schedule (and never before a rate-limit reset the
 *    banner quotes), so storms cannot form.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CHANNEL_NAME,
  COLLECT_LOCK_NAME,
  MIN_SWEEP_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
  RETRY_BACKOFF_MS,
} from './config'
import { collectCycle, type CycleOutcome } from './collector'
import { TodayCache, baselineForNextSave, isUsableBaseline, type CachePair, type IdbLike } from './cache'
import { applyFailureBackoff, shouldApplyBroadcast } from './cycle-controller'
import { sanitizeSnapshot, type AuthMode, type TodaySnapshot } from './normalize'
import { isStale } from './ratelimit'
import { clearToken, currentEpoch, getToken, scrubSecrets, setToken } from './token'

export interface TodayBanner {
  kind: 'partial' | 'rate-limited' | 'network-error' | 'auth-rejected'
  message: string
  retryAtMs: number | null
}

export interface TodayController {
  /** Snapshot to render (freshest available, possibly partial). */
  display: TodaySnapshot | null
  usableBaseline: TodaySnapshot | null
  banner: TodayBanner | null
  collecting: boolean
  authMode: AuthMode
  /** False when IndexedDB is unavailable or failed this session. */
  cachePersistent: boolean
  /** Token card actions; both trigger the auth-change flow. */
  activateToken: (token: string) => void
  clearAuth: () => void
}

const TICK_MS = 5 * 60 * 1000

function parseCollectedAt(snap: TodaySnapshot): number {
  const t = Date.parse(snap.collectedAt)
  return Number.isNaN(t) ? 0 : t
}

function sessionAuthMode(): AuthMode {
  return getToken() !== null ? 'token' : 'anonymous'
}

function makeCache(): TodayCache {
  // Structural cast: the runtime IndexedDB satisfies our minimal async surface.
  const idb = typeof indexedDB !== 'undefined' ? (indexedDB as unknown as IdbLike) : null
  return new TodayCache(idb)
}

export function useTodayData(): TodayController {
  const [display, setDisplay] = useState<TodaySnapshot | null>(null)
  const [usableBaseline, setUsableBaseline] = useState<TodaySnapshot | null>(null)
  const [banner, setBanner] = useState<TodayBanner | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [authMode, setAuthMode] = useState<AuthMode>(sessionAuthMode())
  const [cachePersistent, setCachePersistent] = useState(() => typeof indexedDB !== 'undefined')

  const cacheRef = useRef<TodayCache | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const collectingRef = useRef(false)
  const retryAttemptRef = useRef(0)
  const nextAllowedAtRef = useRef(0)
  const channelRef = useRef<BroadcastChannel | null>(null)
  const displayRef = useRef<TodaySnapshot | null>(null)
  const baselineRef = useRef<TodaySnapshot | null>(null)
  const cachedCompleteRef = useRef<TodaySnapshot | null>(null)
  // When an auth-change cycle is requested while another cycle is still
  // finishing (its abort has not landed yet), the request is queued here and
  // runs as soon as the in-flight cycle exits — never silently dropped.
  const rerunAuthChangeRef = useRef(false)
  // While true, a successful cycle does NOT clear the banner: after a
  // rejected token the immediate anonymous recollect succeeds, and the user
  // must keep seeing WHY they are back on anonymous data. Cleared by the
  // next explicit user auth action.
  const keepBannerRef = useRef(false)

  displayRef.current = display
  baselineRef.current = usableBaseline

  /**
   * Publish a cycle outcome to the UI. Returns 'recollect-anonymous' when the
   * caller should immediately start a fresh anonymous collection (a rejected
   * token clears auth but must not leave the view empty for a whole tick).
   */
  const applyOutcome = useCallback((outcome: CycleOutcome): 'recollect-anonymous' | null => {
    const snapshot = outcome.snapshot
    if (outcome.status === 'complete' && snapshot !== null) {
      retryAttemptRef.current = 0
      setDisplay(snapshot)
      cachedCompleteRef.current = snapshot
      if (!keepBannerRef.current) setBanner(null)
      // Durable cache write happens in the collecting tab only.
    } else if (outcome.status === 'partial' && snapshot !== null) {
      setDisplay(snapshot)
      const kept = cachedCompleteRef.current
      const base =
        outcome.message ?? 'Incomplete collection — data below may be missing repositories or pages.'
      const message =
        kept !== null && parseCollectedAt(kept) < parseCollectedAt(snapshot)
          ? // Fresher partial replaces display but never the durable cache; note
            // the older complete snapshot in the banner for honesty.
            `${base} Last complete collection: ${kept.collectedAt}.`
          : base
      setBanner({ kind: 'partial', message, retryAtMs: outcome.retryAtMs })
    } else if (outcome.status === 'rate-limited') {
      setBanner({
        kind: 'rate-limited',
        message:
          outcome.message ??
          'GitHub rate limit reached — no requests were spent. Showing the last collected data.',
        retryAtMs: outcome.retryAtMs,
      })
    } else if (outcome.status === 'auth-rejected') {
      clearToken()
      setAuthMode('anonymous')
      keepBannerRef.current = true
      setBanner({
        kind: 'auth-rejected',
        message: scrubSecrets(
          outcome.message ?? 'GitHub rejected the token.',
        ) + ' Showing anonymous data instead.',
        retryAtMs: null,
      })
      return 'recollect-anonymous'
    } else if (outcome.status === 'network-error') {
      setBanner({
        kind: 'network-error',
        message:
          outcome.message ??
          'Could not reach api.github.com. Showing the last collected data (if any).',
        retryAtMs: outcome.retryAtMs,
      })
    }
    return null
  }, [])

  const runCycle = useCallback(
    async (reason: 'initial' | 'scheduled' | 'auth-change') => {
      if (collectingRef.current) {
        if (reason === 'auth-change') rerunAuthChangeRef.current = true
        return
      }
      const now = Date.now()
      if (reason !== 'auth-change' && now < nextAllowedAtRef.current) return
      collectingRef.current = true
      setCollecting(true)
      nextAllowedAtRef.current = now + MIN_SWEEP_INTERVAL_MS

      const epoch = currentEpoch()
      const token = getToken()
      const auth: AuthMode = token !== null ? 'token' : 'anonymous'
      const controller = new AbortController()
      abortRef.current = controller

      // Missing-PR checks must run against the baseline the NEXT save will
      // produce (post-rotation) — the one SinceYesterdayCard will diff.
      let baselineForChecks: TodaySnapshot | null = baselineRef.current
      if (cacheRef.current !== null) {
        try {
          const pair: CachePair = await cacheRef.current.load()
          baselineForChecks = baselineForNextSave(pair, {
            collectedAt: new Date(now).toISOString(),
            authMode: auth,
          })
        } catch {
          /* cache read failed: fall back to the in-memory baseline */
        }
      }

      let outcome: CycleOutcome
      try {
        outcome = await collectCycle({
          fetchImpl: (input, init) => fetch(input, init),
          nowMs: () => Date.now(),
          token,
          signal: controller.signal,
          baseline: baselineForChecks,
        })
      } catch (err) {
        outcome = {
          status: 'network-error',
          snapshot: null,
          retryAtMs: null,
          message: scrubSecrets(err instanceof Error ? err.message : 'Unexpected collection error'),
          requestsUsed: 0,
        }
      }

      // Auth changed mid-flight (Use token/Clear pressed elsewhere): the
      // epoch moved on, so these results must never be published.
      if (epoch !== currentEpoch()) {
        collectingRef.current = false
        setCollecting(false)
        if (rerunAuthChangeRef.current) {
          rerunAuthChangeRef.current = false
          void runCycle('auth-change')
        }
        return
      }
      abortRef.current = null
      collectingRef.current = false
      setCollecting(false)

      const recollect = applyOutcome(outcome)

      if (outcome.status === 'complete' && outcome.snapshot !== null && cacheRef.current !== null) {
        try {
          const pair: CachePair = await cacheRef.current.saveComplete(outcome.snapshot)
          // Auth changed while the multi-transaction save was in flight: the
          // save wrote the PREVIOUS auth mode's snapshot back into the cache
          // after authChange's clearAll. Wipe it again and publish nothing —
          // stale cross-auth state must never reach the UI or survive on disk.
          if (epoch !== currentEpoch()) {
            void cacheRef.current.clearAll()
            if (rerunAuthChangeRef.current) {
              rerunAuthChangeRef.current = false
              void runCycle('auth-change')
            }
            return
          }
          cachedCompleteRef.current = pair.current
          setUsableBaseline(
            pair.current !== null && isUsableBaseline(pair.baseline, pair.current, Date.now())
              ? pair.baseline
              : null,
          )
        } catch (err) {
          // Cache write failed: the display still shows the fresh snapshot;
          // persistence is degraded for this session — surface it, scrubbed.
          setCachePersistent(false)
          console.warn('[today] cache write failed:', scrubSecrets(err instanceof Error ? err.message : String(err)))
        }
        if (cacheRef.current.operational === false) setCachePersistent(false)
      }

      if (outcome.status !== 'complete') {
        const backoff = applyFailureBackoff({
          nowMs: Date.now(),
          attempt: retryAttemptRef.current,
          backoffMs: RETRY_BACKOFF_MS,
          outcomeRetryAtMs: outcome.retryAtMs,
          currentAllowedAt: nextAllowedAtRef.current,
        })
        retryAttemptRef.current = backoff.nextAttempt
        nextAllowedAtRef.current = backoff.nextAllowedAt
      }

      // Tell other tabs (they apply only if their auth mode matches).
      try {
        channelRef.current?.postMessage({
          type: 'cycle',
          authMode: outcome.snapshot?.authMode ?? auth,
          outcome,
        })
      } catch {
        /* channel closed — single-tab environment */
      }

      if (recollect === 'recollect-anonymous') {
        // The token was rejected and cleared: collect anonymously right away
        // instead of leaving an empty view until the staleness tick.
        retryAttemptRef.current = 0
        nextAllowedAtRef.current = 0
        collectWithLockRef.current?.('auth-change')
        return
      }

      // An auth-change cycle was queued while this one finished: run it now.
      if (rerunAuthChangeRef.current) {
        rerunAuthChangeRef.current = false
        void runCycle('auth-change')
      }
    },
    [applyOutcome],
  )

  // Late-bound reference so runCycle can trigger the lock-guarded collection
  // without a circular useCallback dependency.
  const collectWithLockRef = useRef<((reason: 'initial' | 'scheduled' | 'auth-change') => void) | null>(null)

  /**
   * Collect under the cross-tab lock. Scheduled/initial cycles skip when
   * another tab is collecting (its broadcast updates us). Auth-change cycles
   * WAIT for the lock instead: the user just switched credentials and the
   * collection under the new auth must never be silently dropped.
   */
  const collectWithLock = useCallback(
    (reason: 'initial' | 'scheduled' | 'auth-change') => {
      collectWithLockRef.current = collectWithLock
      const nav = navigator as Navigator & {
        locks?: {
          request: (
            name: string,
            options: { ifAvailable: boolean },
            callback: (lock: unknown) => Promise<void>,
          ) => Promise<void>
        }
      }
      const runUnlocked = () => {
        void runCycle(reason)
      }
      if (nav.locks !== undefined) {
        void nav.locks
          .request(COLLECT_LOCK_NAME, { ifAvailable: reason !== 'auth-change' }, async (lock) => {
            if (lock === null) return // another tab is collecting; its broadcast will update us
            await runCycle(reason)
          })
          .catch(() => {
            // Lock machinery failed (e.g. sandboxed frame): collect without
            // the lock rather than staying silently stale.
            runUnlocked()
          })
      } else {
        runUnlocked()
      }
    },
    [runCycle],
  )
  collectWithLockRef.current = collectWithLock

  const authChange = useCallback(
    (mode: AuthMode) => {
      abortRef.current?.abort()
      retryAttemptRef.current = 0
      nextAllowedAtRef.current = 0
      keepBannerRef.current = false
      setAuthMode(mode)
      setDisplay(null)
      cachedCompleteRef.current = null
      setUsableBaseline(null)
      setBanner(null)
      void cacheRef.current?.clearAll().then(() => {
        collectWithLock('auth-change')
      })
    },
    [collectWithLock],
  )

  const activateToken = useCallback(
    (token: string) => {
      if (token.trim().length === 0) return
      setToken(token)
      authChange('token')
    },
    [authChange],
  )

  const clearAuth = useCallback(() => {
    clearToken()
    authChange('anonymous')
  }, [authChange])

  // ---- Mount: cache-first paint, then collect if missing/stale.
  useEffect(() => {
    const cache = makeCache()
    cacheRef.current = cache
    let cancelled = false

    void cache.load().then((pair) => {
      if (cancelled) return
      if (cache.operational === false) setCachePersistent(false)
      // Auth-derived data from a DIFFERENT auth mode must not survive into
      // this session (a reload drops the token; navigating away and back
      // does not). Clear only on mismatch so a token session remounting
      // keeps — instead of wiping — its own token-derived cache.
      const session = sessionAuthMode()
      if (pair.current !== null && pair.current.authMode !== session) {
        void cache.clearAll().then(() => {
          if (!cancelled) collectWithLock('initial')
        })
        return
      }
      if (pair.current !== null) {
        setDisplay(pair.current)
        cachedCompleteRef.current = pair.current
      }
      // A seeded/persisted baseline is usable even when no current snapshot
      // exists yet: the upcoming fresh collection can still run bounded
      // missing-PR checks against it (same auth, age window respected).
      if (isUsableBaseline(pair.baseline, pair.current, Date.now())) {
        setUsableBaseline(pair.baseline)
      }
      if (
        pair.current === null ||
        isStale(parseCollectedAt(pair.current), Date.now(), REFRESH_INTERVAL_MS)
      ) {
        collectWithLock('initial')
      }
    })

    // ---- Cross-tab: apply broadcasts from the tab that collected.
    const channel =
      typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null
    channelRef.current = channel
    if (channel !== null) {
      channel.onmessage = (event: MessageEvent) => {
        if (!shouldApplyBroadcast(event.data, sessionAuthMode())) return
        const msg = event.data
        // Broadcast payloads are untrusted input: revalidate the snapshot
        // (every PR's URLs/dates/identity) before it can reach an <a href>,
        // and coerce the banner fields — a non-string message would crash
        // rendering and a bogus retryAtMs would throw in TodayStatus,
        // blanking every listening tab.
        if (msg.outcome.snapshot !== null) {
          const clean = sanitizeSnapshot(msg.outcome.snapshot)
          if (clean === null) return
          msg.outcome = { ...msg.outcome, snapshot: clean }
        }
        const message = typeof msg.outcome.message === 'string' ? msg.outcome.message.slice(0, 300) : null
        const retryAtMs =
          typeof msg.outcome.retryAtMs === 'number' &&
          Number.isFinite(msg.outcome.retryAtMs) &&
          msg.outcome.retryAtMs > Date.now() - 60_000 &&
          msg.outcome.retryAtMs < Date.now() + 24 * 60 * 60 * 1000
            ? msg.outcome.retryAtMs
            : null
        msg.outcome = { ...msg.outcome, message, retryAtMs }
        applyOutcome(msg.outcome)
        if (msg.outcome.status === 'complete') {
          void cacheRef.current?.load().then((pair) => {
            if (cancelled || pair.current === null) return
            cachedCompleteRef.current = pair.current
            setUsableBaseline(
              isUsableBaseline(pair.baseline, pair.current, Date.now()) ? pair.baseline : null,
            )
          })
        }
      }
    }

    // ---- Staleness tick (5 min) + visibility return; page open only.
    const tick = () => {
      const current = displayRef.current
      if (current === null) {
        collectWithLock('scheduled')
        return
      }
      if (isStale(parseCollectedAt(current), Date.now(), REFRESH_INTERVAL_MS)) {
        collectWithLock('scheduled')
      }
    }
    const interval = window.setInterval(tick, TICK_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
      channel?.close()
      channelRef.current = null
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    display,
    usableBaseline,
    banner,
    collecting,
    authMode,
    cachePersistent,
    activateToken,
    clearAuth,
  }
}
