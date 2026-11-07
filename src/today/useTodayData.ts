/**
 * React glue for the Today view: cache-first paint, stale-triggered
 * collection, cross-tab coordination, auth transitions, backoff.
 *
 * Behavioral contract (e2e-tested):
 *  - On mount: paint the IndexedDB cache immediately, then collect only if
 *    the cache is missing/stale (reopen uses cache first).
 *  - While the page is open, a 5-minute tick refreshes when the snapshot is
 *    older than REFRESH_INTERVAL_MS (3h). No collection ever happens with
 *    the page closed; the UI says so rather than implying background work.
 *  - Only one tab collects at a time (Web Locks); outcomes broadcast to
 *    other tabs, which apply them only when the auth mode matches their own.
 *  - Auth transitions (Use token / Clear) abort in-flight cycles, clear all
 *    auth-derived cached data, and immediately recollect; results collected
 *    under a superseded auth epoch are discarded, never published.
 *  - Failed cycles never overwrite the last good cached snapshot; retries
 *    follow the backoff schedule so storms cannot form.
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
import { TodayCache, isUsableBaseline, type CachePair, type IdbLike } from './cache'
import type { TodaySnapshot } from './normalize'
import { isStale, retryDelayMs } from './ratelimit'
import { clearToken, currentEpoch, getToken, scrubSecrets, setToken } from './token'

export interface TodayBanner {
  kind: 'partial' | 'rate-limited' | 'network-error' | 'auth-rejected' | 'info'
  message: string
  retryAtMs: number | null
}

export interface TodayController {
  /** Snapshot to render (freshest available, possibly partial). */
  display: TodaySnapshot | null
  /** True when `display` is a partial sweep (banner explains the reason). */
  displayIsPartial: boolean
  /** Last complete snapshot kept in the durable cache (may be older). */
  cachedComplete: TodaySnapshot | null
  usableBaseline: TodaySnapshot | null
  banner: TodayBanner | null
  collecting: boolean
  authMode: 'anonymous' | 'token'
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

function makeCache(): TodayCache {
  // Structural cast: the runtime IndexedDB satisfies our minimal async surface.
  const idb = typeof indexedDB !== 'undefined' ? (indexedDB as unknown as IdbLike) : null
  return new TodayCache(idb)
}

export function useTodayData(): TodayController {
  const [display, setDisplay] = useState<TodaySnapshot | null>(null)
  const [cachedComplete, setCachedComplete] = useState<TodaySnapshot | null>(null)
  const [usableBaseline, setUsableBaseline] = useState<TodaySnapshot | null>(null)
  const [banner, setBanner] = useState<TodayBanner | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [authMode, setAuthMode] = useState<'anonymous' | 'token'>(getToken() !== null ? 'token' : 'anonymous')
  const [cachePersistent] = useState(() => typeof indexedDB !== 'undefined')

  const cacheRef = useRef<TodayCache | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const collectingRef = useRef(false)
  const lastSweepAtRef = useRef(0)
  const retryAttemptRef = useRef(0)
  const nextAllowedAtRef = useRef(0)
  const channelRef = useRef<BroadcastChannel | null>(null)
  const displayRef = useRef<TodaySnapshot | null>(null)
  const baselineRef = useRef<TodaySnapshot | null>(null)
  // When an auth-change cycle is requested while another cycle is still
  // finishing (its abort has not landed yet), the request is queued here and
  // runs as soon as the in-flight cycle exits — never silently dropped.
  const rerunAuthChangeRef = useRef(false)

  displayRef.current = display
  baselineRef.current = usableBaseline

  const applyOutcome = useCallback((outcome: CycleOutcome) => {
    const snapshot = outcome.snapshot
    if (outcome.status === 'complete' && snapshot !== null) {
      retryAttemptRef.current = 0
      setDisplay(snapshot)
      setCachedComplete(snapshot)
      setBanner(null)
      // Durable cache write happens in the collecting tab only.
    } else if (outcome.status === 'partial' && snapshot !== null) {
      setDisplay(snapshot)
      const kept = cachedCompleteRef.current
      setBanner({
        kind: 'partial',
        message:
          outcome.message ??
          'Incomplete collection — data below may be missing repositories or pages.',
        retryAtMs: outcome.retryAtMs,
      })
      if (kept !== null && parseCollectedAt(kept) < parseCollectedAt(snapshot)) {
        // Fresher partial replaces display but never the durable cache; note
        // the older complete snapshot in the banner for honesty.
        setBanner({
          kind: 'partial',
          message: `${
            outcome.message ?? 'Incomplete collection — data below may be missing repositories or pages.'
          } Last complete collection: ${kept.collectedAt}.`,
          retryAtMs: outcome.retryAtMs,
        })
      }
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
      setBanner({
        kind: 'auth-rejected',
        message: scrubSecrets(outcome.message ?? 'GitHub rejected the token.'),
        retryAtMs: null,
      })
    } else if (outcome.status === 'network-error') {
      setBanner({
        kind: 'network-error',
        message:
          outcome.message ??
          'Could not reach api.github.com. Showing the last collected data (if any).',
        retryAtMs: outcome.retryAtMs,
      })
    }
  }, [])

  // cachedComplete needed inside applyOutcome without re-subscribing effects.
  const cachedCompleteRef = useRef<TodaySnapshot | null>(null)
  cachedCompleteRef.current = cachedComplete

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
      lastSweepAtRef.current = now
      nextAllowedAtRef.current = now + MIN_SWEEP_INTERVAL_MS

      const epoch = currentEpoch()
      const token = getToken()
      const controller = new AbortController()
      abortRef.current = controller

      let outcome: CycleOutcome
      try {
        outcome = await collectCycle({
          fetchImpl: (input, init) => fetch(input, init),
          nowMs: () => Date.now(),
          token,
          signal: controller.signal,
          baseline: baselineRef.current,
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

      applyOutcome(outcome)

      if (outcome.status === 'complete' && outcome.snapshot !== null && cacheRef.current !== null) {
        try {
          const pair: CachePair = await cacheRef.current.saveComplete(outcome.snapshot)
          setCachedComplete(pair.current)
          setUsableBaseline(
            pair.current !== null && isUsableBaseline(pair.baseline, pair.current, Date.now())
              ? pair.baseline
              : null,
          )
        } catch {
          // Cache write failed: the display still shows the fresh snapshot;
          // persistence degrades for this session.
        }
      }

      if (outcome.status !== 'complete') {
        const delay = retryDelayMs(retryAttemptRef.current, RETRY_BACKOFF_MS)
        retryAttemptRef.current += 1
        if (delay !== null) {
          nextAllowedAtRef.current = Math.max(
            nextAllowedAtRef.current,
            Date.now() + delay,
          )
        } else {
          // Backoff exhausted: wait for the natural staleness tick.
          retryAttemptRef.current = 0
        }
      }

      // Tell other tabs (they apply only if their auth mode matches).
      try {
        channelRef.current?.postMessage({
          type: 'cycle',
          authMode: outcome.snapshot?.authMode ?? (token !== null ? 'token' : 'anonymous'),
          outcome,
        })
      } catch {
        /* channel closed — single-tab environment */
      }

      // An auth-change cycle was queued while this one finished: run it now.
      if (rerunAuthChangeRef.current) {
        rerunAuthChangeRef.current = false
        void runCycle('auth-change')
      }
    },
    [applyOutcome],
  )

  /** Collect under the cross-tab lock; skip when another tab is collecting. */
  const collectWithLock = useCallback(
    (reason: 'initial' | 'scheduled' | 'auth-change') => {
      const nav = navigator as Navigator & {
        locks?: {
          request: (
            name: string,
            options: { ifAvailable: boolean },
            callback: (lock: unknown) => Promise<void>,
          ) => Promise<void>
        }
      }
      if (nav.locks !== undefined) {
        void nav.locks
          .request(COLLECT_LOCK_NAME, { ifAvailable: true }, async (lock) => {
            if (lock === null) return // another tab is collecting; its broadcast will update us
            await runCycle(reason)
          })
          .catch(() => {
            /* locks unavailable — fall through below */
          })
      } else {
        void runCycle(reason)
      }
    },
    [runCycle],
  )

  const authChange = useCallback(
    (mode: 'token' | 'anonymous') => {
      abortRef.current?.abort()
      retryAttemptRef.current = 0
      nextAllowedAtRef.current = 0
      setAuthMode(mode)
      setDisplay(null)
      setCachedComplete(null)
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
      // A previous session's token-derived cache must not survive into an
      // anonymous session (auth changed by the reload itself): clear it.
      if (pair.current !== null && pair.current.authMode === 'token') {
        void cache.clearAll().then(() => {
          if (!cancelled) collectWithLock('initial')
        })
        return
      }
      if (pair.current !== null) {
        setDisplay(pair.current)
        setCachedComplete(pair.current)
      }
      // A seeded/persisted baseline is usable even when no current snapshot
      // exists yet: the upcoming fresh collection (anonymous on a new load)
      // can still run bounded missing-PR checks against it.
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
        const msg = event.data as
          | { type: 'cycle'; authMode: 'anonymous' | 'token'; outcome: CycleOutcome }
          | null
        if (msg === null || typeof msg !== 'object' || msg.type !== 'cycle') return
        if (msg.authMode !== (getToken() !== null ? 'token' : 'anonymous')) return
        applyOutcome(msg.outcome)
        if (msg.outcome.status === 'complete') {
          void cacheRef.current?.load().then((pair) => {
            if (cancelled || pair.current === null) return
            setCachedComplete(pair.current)
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
    displayIsPartial: display !== null && !display.complete,
    cachedComplete,
    usableBaseline,
    banner,
    collecting,
    authMode,
    cachePersistent,
    activateToken,
    clearAuth,
  }
}
