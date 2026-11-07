/**
 * Collection cycle orchestration for the Today view.
 *
 * One cycle = pre-flight (anonymous only, free endpoint) + a bounded sweep of
 * open PRs across the configured repos + (after a complete sweep, when a
 * usable baseline exists) bounded missing-PR state checks.
 *
 * Honesty rules:
 *  - A cycle reports `complete` only when every repo paginated fully within
 *    budget; anything else is `partial` with an explicit reason and is never
 *    written to the durable cache (last good data is preserved).
 *  - Anonymous cycles pre-flight the free rate_limit endpoint and refuse to
 *    start when the shared-IP budget cannot fit a sweep — burning quota to
 *    discover exhaustion is avoided entirely.
 *  - Results carry the epoch they were collected under; the hook discards
 *    any result whose epoch no longer matches (auth changed mid-flight).
 */

import {
  CYCLE_REQUEST_CAP_ANONYMOUS,
  CYCLE_REQUEST_CAP_TOKEN,
  MAX_PAGES_PER_REPO,
  MISSING_CHECK_MAX,
  PULLS_PER_PAGE,
  RATE_FLOOR_ANONYMOUS,
  RATE_FLOOR_TOKEN,
  SWEEP_PAGE_ESTIMATE,
  TODAY_REPOS,
} from './config'
import { assetsAuthored, needsAssetsReview } from './classify'
import {
  GitHubError,
  getCoreRateLimit,
  githubGet,
  pullDetailUrl,
  pullsListUrl,
  type FetchLike,
  type RawPull,
  type RawPullDetail,
} from './github'
import {
  prId,
  TODAY_SCHEMA_VERSION,
  type AuthMode,
  type MissingPrCheck,
  type PartialReason,
  type RepoSweepInfo,
  type TodayPr,
  type TodaySnapshot,
} from './normalize'
import { CycleBudget } from './ratelimit'
import { scrubSecrets } from './token'
import { isUsableBaseline } from './cache'
import { normalizePull as normalizePullImpl } from './normalize'

export type CycleStatus =
  | 'complete'
  | 'partial'
  | 'rate-limited'
  | 'auth-rejected'
  | 'network-error'
  | 'aborted'

export interface CycleOutcome {
  status: CycleStatus
  /** Present for complete/partial cycles (never cached unless complete). */
  snapshot: TodaySnapshot | null
  /** Epoch-ms hint for the next allowed attempt. */
  retryAtMs: number | null
  /** Scrubbed, one-line human explanation. */
  message: string | null
  requestsUsed: number
}

export interface CycleDeps {
  fetchImpl: FetchLike
  nowMs: () => number
  token: string | null
  signal: AbortSignal
  /** Durable baseline snapshot (drives bounded missing-PR checks). */
  baseline: TodaySnapshot | null
}

function errIsKind(err: unknown, kind: GitHubError['kind']): boolean {
  return err instanceof GitHubError && err.kind === kind
}

/** Run one collection cycle. Pure w.r.t. deps (fully unit-testable). */
export async function collectCycle(deps: CycleDeps): Promise<CycleOutcome> {
  const authMode: AuthMode = deps.token !== null ? 'token' : 'anonymous'
  const cap = authMode === 'anonymous' ? CYCLE_REQUEST_CAP_ANONYMOUS : CYCLE_REQUEST_CAP_TOKEN
  const floor = authMode === 'anonymous' ? RATE_FLOOR_ANONYMOUS : RATE_FLOOR_TOKEN

  // ---- Pre-flight: anonymous sweeps must fit the shared 60/hour IP budget.
  if (authMode === 'anonymous') {
    try {
      const core = await getCoreRateLimit({
        fetchImpl: deps.fetchImpl,
        token: null,
        signal: deps.signal,
        nowMs: deps.nowMs(),
      })
      if (core.remaining !== null && core.remaining < SWEEP_PAGE_ESTIMATE + floor) {
        return {
          status: 'rate-limited',
          snapshot: null,
          retryAtMs: core.reset !== null ? core.reset * 1000 : deps.nowMs() + 60_000,
          message:
            core.remaining <= 0
              ? 'GitHub anonymous rate limit exhausted for this network — retry after the reset time.'
              : 'GitHub anonymous rate limit too low to fit a full sweep on this shared network — not spending requests.',
          requestsUsed: 0,
        }
      }
    } catch (err) {
      // Pre-flight failure is non-fatal: proceed under budget-guard control.
      if (errIsKind(err, 'aborted')) return abortedOutcome()
      if (errIsKind(err, 'auth-rejected')) return authRejectedOutcome()
      // otherwise (network/5xx): the sweep itself will report the failure
    }
  }

  const budget = new CycleBudget(cap, floor)
  const prs: TodayPr[] = []
  const repos: RepoSweepInfo[] = []
  let dropped = 0
  let partialReason: PartialReason | null = null
  let stopRetryAt: number | null = null
  let stopMessage: string | null = null
  let lastRate: TodaySnapshot['rate'] = null
  let aborted = false
  let authRejected = false

  // ---- Sweep: every configured repo, page by page.
  for (const repo of TODAY_REPOS) {
    // page-cap / repo-missing on one repo still lets later repos collect:
    // their entries are complete; the snapshot stays partial and honestly
    // labelled. Any other stoppage ends the sweep.
    if (
      aborted ||
      authRejected ||
      (partialReason !== null && partialReason !== 'page-cap' && partialReason !== 'repo-missing')
    ) {
      break
    }
    let page = 1
    let repoComplete = false
    const pagesFetched = { count: 0 }
    // Defensive de-duplication: GitHub pagination glitches must never
    // duplicate rows (same repo + number).
    const seenNumbers = new Set<number>()

    while (page <= MAX_PAGES_PER_REPO) {
      const allowance = budget.allow(deps.nowMs())
      if (!allowance.ok) {
        if (allowance.reason === 'floor' || allowance.reason === 'wall') {
          partialReason = 'rate-limit'
          stopRetryAt = deps.nowMs() + 60_000
          stopMessage = 'Stopped early: rate-limit floor reached — remaining quota preserved for other users of this network.'
        } else {
          partialReason = 'budget'
          stopMessage = 'Stopped early: per-cycle request budget reached.'
        }
        break
      }
      budget.spend()
      let response
      try {
        response = await githubGet<RawPull[]>(pullsListUrl(repo, page), {
          fetchImpl: deps.fetchImpl,
          token: deps.token,
          signal: deps.signal,
          nowMs: deps.nowMs(),
        })
      } catch (err) {
        if (errIsKind(err, 'aborted')) {
          aborted = true
        } else if (errIsKind(err, 'auth-rejected')) {
          authRejected = true
        } else if (errIsKind(err, 'rate-limited')) {
          partialReason = 'rate-limit'
          stopRetryAt = err instanceof GitHubError ? err.retryAtMs : null
          stopMessage = 'Rate limited mid-sweep — kept the pages already fetched.'
        } else if (errIsKind(err, 'not-found')) {
          partialReason = 'repo-missing'
          stopMessage = `${repo} was not found (HTTP 404) — it may be private, renamed or removed. Its data is missing from this snapshot; other repos were still collected.`
        } else if (errIsKind(err, 'network')) {
          partialReason = 'network'
          stopMessage = pagesFetched.count === 0 && repos.length === 0
            ? 'Could not reach api.github.com — nothing was collected.'
            : 'Network error mid-sweep — kept the pages already fetched.'
        } else {
          partialReason = 'network'
          stopMessage = scrubSecrets(err instanceof Error ? err.message : 'Unexpected error')
        }
        break
      }

      budget.observeRemaining(response.rate.remaining)
      if (response.rate.limit !== null || response.rate.remaining !== null || response.rate.reset !== null) {
        lastRate = {
          limit: response.rate.limit,
          remaining: response.rate.remaining,
          reset: response.rate.reset !== null ? new Date(response.rate.reset * 1000).toISOString() : null,
        }
      }

      const items = Array.isArray(response.data) ? response.data : []
      for (const raw of items) {
        const normalized = normalizePullSafe(repo, raw)
        if (normalized === null) {
          dropped += 1
          continue
        }
        if (seenNumbers.has(normalized.number)) continue
        seenNumbers.add(normalized.number)
        prs.push(normalized)
      }
      pagesFetched.count = page

      const morePages = response.linkNext && items.length >= PULLS_PER_PAGE
      if (!morePages) {
        repoComplete = true
        break
      }
      if (page === MAX_PAGES_PER_REPO) {
        // Link says more pages exist but the per-repo cap is hit.
        partialReason = 'page-cap'
        stopMessage = `${repo} has more open PRs than the per-repo page cap — results truncated.`
        break
      }
      page += 1
    }

    repos.push({ repo, pagesFetched: pagesFetched.count, complete: repoComplete })
  }

  if (aborted) return abortedOutcome(budget.usedCount)
  if (authRejected) return authRejectedOutcome(budget.usedCount)

  if (partialReason === 'network' && prs.length === 0 && repos.every((r) => !r.complete)) {
    return {
      status: 'network-error',
      snapshot: null,
      retryAtMs: null,
      message: stopMessage ?? 'Could not reach api.github.com.',
      requestsUsed: budget.usedCount,
    }
  }

  const complete = partialReason === null && repos.every((r) => r.complete)

  // ---- Bounded missing-PR state checks (complete sweeps with a usable baseline).
  const missingChecks: MissingPrCheck[] = []
  if (complete && deps.baseline !== null) {
    // Usability is measured against the snapshot being built (now).
    const inProgress = {
      collectedAt: new Date(deps.nowMs()).toISOString(),
      authMode,
      complete: true,
    } as TodaySnapshot
    if (isUsableBaseline(deps.baseline, inProgress, deps.nowMs())) {
      const currentIds = new Set(prs.map(prId))
      const baselineQueue = deps.baseline.prs.filter((p) => needsAssetsReview(p) || assetsAuthored(p))
      const missing = baselineQueue
        .filter((p) => !currentIds.has(prId(p)))
        .sort((a, b) => a.number - b.number)
        .slice(0, MISSING_CHECK_MAX)
      for (const pr of missing) {
        const allowance = budget.allow(deps.nowMs())
        if (!allowance.ok) break // remaining entries stay 'unverified' — never guessed
        budget.spend()
        try {
          const res = await githubGet<RawPullDetail>(pullDetailUrl(pr.repo, pr.number), {
            fetchImpl: deps.fetchImpl,
            token: deps.token,
            signal: deps.signal,
            nowMs: deps.nowMs(),
          })
          budget.observeRemaining(res.rate.remaining)
          const state: MissingPrCheck['state'] =
            res.data?.merged_at != null
              ? 'MERGED'
              : res.data?.state === 'closed'
                ? 'CLOSED'
                : res.data?.state === 'open'
                  ? 'OPEN'
                  : 'unknown'
          missingChecks.push({ repo: pr.repo, number: pr.number, state })
        } catch (err) {
          if (errIsKind(err, 'aborted')) return abortedOutcome(budget.usedCount)
          if (errIsKind(err, 'auth-rejected')) return authRejectedOutcome(budget.usedCount)
          // Rate limit or error during a check: stop checking; the diff
          // labels the rest unverified.
          missingChecks.push({ repo: pr.repo, number: pr.number, state: 'unknown' })
          break
        }
      }
    }
  }

  const snapshot: TodaySnapshot = {
    schemaVersion: TODAY_SCHEMA_VERSION,
    collectedAt: new Date(deps.nowMs()).toISOString(),
    authMode,
    repos,
    complete,
    partialReason,
    rate: lastRate,
    prs,
    droppedMalformed: dropped,
    missingChecks,
  }

  return {
    status: complete ? 'complete' : 'partial',
    snapshot,
    retryAtMs: stopRetryAt,
    message: stopMessage,
    requestsUsed: budget.usedCount,
  }
}

function normalizePullSafe(repo: string, raw: RawPull): TodayPr | null {
  try {
    return normalizePullImpl(repo, raw)
  } catch {
    return null
  }
}

function abortedOutcome(requestsUsed = 0): CycleOutcome {
  return { status: 'aborted', snapshot: null, retryAtMs: null, message: 'Collection cancelled.', requestsUsed }
}

function authRejectedOutcome(requestsUsed = 0): CycleOutcome {
  return {
    status: 'auth-rejected',
    snapshot: null,
    retryAtMs: null,
    message: 'GitHub rejected the token (HTTP 401) — it was cleared from memory. Check the token value, expiry and that it can read public repositories.',
    requestsUsed,
  }
}
