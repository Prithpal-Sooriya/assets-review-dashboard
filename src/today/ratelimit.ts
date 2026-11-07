/**
 * Pure rate-limit / pagination helpers. No fetch, no DOM — fully unit-tested.
 * GitHub primary limits surface via X-RateLimit-* headers; secondary limits
 * answer 403/429 with a Retry-After header. All of it is honored here.
 */

export interface RateInfo {
  limit: number | null
  remaining: number | null
  /** Epoch seconds. */
  reset: number | null
}

/** Parse X-RateLimit-* headers (values are strings or null). */
export function parseRateHeaders(headers: {
  get(name: string): string | null
}): RateInfo {
  const limit = headers.get('x-ratelimit-limit')
  const remaining = headers.get('x-ratelimit-remaining')
  const reset = headers.get('x-ratelimit-reset')
  return {
    limit: limit !== null && /^\d+$/.test(limit) ? Number(limit) : null,
    remaining: remaining !== null && /^\d+$/.test(remaining) ? Number(remaining) : null,
    reset: reset !== null && /^\d+$/.test(reset) ? Number(reset) : null,
  }
}

/** True when the response status means "rate limited" (primary or secondary). */
export function isRateLimitedStatus(status: number): boolean {
  return status === 429 || status === 403
}

/**
 * When to retry after a rate-limited response, in epoch ms.
 * Secondary limits carry Retry-After (seconds); primary limits carry the
 * X-RateLimit-Reset epoch. Falls back to a conservative 60s.
 */
export function rateRetryAtMs(
  status: number,
  headers: { get(name: string): string | null },
  nowMs: number,
): number {
  if (isRateLimitedStatus(status)) {
    const retryAfter = headers.get('retry-after')
    if (retryAfter !== null && /^\d+$/.test(retryAfter)) {
      return nowMs + Number(retryAfter) * 1000
    }
    const reset = headers.get('x-ratelimit-reset')
    if (reset !== null && /^\d+$/.test(reset)) {
      return Number(reset) * 1000
    }
    return nowMs + 60_000
  }
  return nowMs
}

/** Does a Link header advertise a rel="next" page? */
export function linkHasNext(linkHeader: string | null): boolean {
  if (linkHeader === null) return false
  return /rel="next"/.test(linkHeader) || /rel='next'/.test(linkHeader)
}

/**
 * Budget guard for one collection cycle. Every request checks `allow()` and
 * reports `spend()`; the guard enforces:
 *  - a hard cap on requests per cycle,
 *  - a floor on X-RateLimit-Remaining so shared-IP quota is left for others,
 *  - an optional wall: after `retryNotBeforeMs` no further spending happens.
 */
export class CycleBudget {
  private used = 0
  private lastRemaining: number | null = null

  constructor(
    private readonly cap: number,
    private readonly floor: number,
    private readonly retryNotBeforeMs: number | null = null,
  ) {}

  get usedCount(): number {
    return this.used
  }

  get remainingObserved(): number | null {
    return this.lastRemaining
  }

  /** Record headers of a completed request (updates the remaining floor). */
  observeRemaining(remaining: number | null): void {
    if (remaining !== null) this.lastRemaining = remaining
  }

  /** May the next request be sent? `reason` explains the first blocker. */
  allow(nowMs: number): { ok: true } | { ok: false; reason: 'cap' | 'floor' | 'wall' } {
    if (this.retryNotBeforeMs !== null && nowMs < this.retryNotBeforeMs) {
      return { ok: false, reason: 'wall' }
    }
    if (this.used >= this.cap) return { ok: false, reason: 'cap' }
    if (this.lastRemaining !== null && this.lastRemaining <= this.floor) {
      return { ok: false, reason: 'floor' }
    }
    return { ok: true }
  }

  spend(): void {
    this.used += 1
  }
}

/** Is a cached snapshot stale (older than the refresh interval)? */
export function isStale(collectedAtMs: number, nowMs: number, intervalMs: number): boolean {
  return nowMs - collectedAtMs >= intervalMs
}

/** Backoff delay for retry attempt N (0-based). Null: stop retrying. */
export function retryDelayMs(attempt: number, schedule: readonly number[]): number | null {
  return attempt < schedule.length ? (schedule[attempt] ?? null) : null
}
