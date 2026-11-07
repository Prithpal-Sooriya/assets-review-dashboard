/**
 * Pure decision logic for the Today collection loop, extracted from the
 * React hook so it can be unit-tested without a browser:
 *
 *  - failure backoff (including rate-limit reset walls from outcomes);
 *  - which cross-tab broadcasts a tab may apply;
 *  - what the next save's baseline slot will hold (preview used so
 *    missing-PR checks run against the baseline the UI will actually diff).
 *
 * The hook stays thin wiring: refs, effects, Web Locks, BroadcastChannel.
 */

import type { CycleOutcome } from './collector'
import type { AuthMode } from './normalize'

/** Advance the failure backoff after a non-complete cycle. */
export interface BackoffInputs {
  nowMs: number
  /** Consecutive failed cycles so far (before this one). */
  attempt: number
  /** Backoff schedule in ms, e.g. [5, 15, 45] * 60_000; null = give up. */
  backoffMs: readonly (number | null)[]
  /** Retry wall reported by the outcome (e.g. rate-limit reset), if any. */
  outcomeRetryAtMs: number | null
  /** Current "not before" gate already in force. */
  currentAllowedAt: number
}

export interface BackoffResult {
  /** Next time a scheduled (non-auth-change) cycle may run. */
  nextAllowedAt: number
  /** Attempt counter to carry forward. */
  nextAttempt: number
}

/**
 * Backoff after a failed cycle. The gate is the max of the schedule step and
 * any rate-limit reset wall the outcome reported — the UI banner quotes that
 * wall, so the actual schedule must never attempt earlier than it.
 * When the schedule is exhausted, the natural staleness tick takes over.
 */
export function applyFailureBackoff(inputs: BackoffInputs): BackoffResult {
  const step = inputs.backoffMs[inputs.attempt] ?? null
  const nextAttempt = step !== null ? inputs.attempt + 1 : 0
  const candidate =
    step !== null
      ? Math.max(inputs.nowMs + step, inputs.outcomeRetryAtMs ?? 0)
      : inputs.outcomeRetryAtMs ?? 0
  return {
    nextAllowedAt: Math.max(inputs.currentAllowedAt, candidate),
    nextAttempt,
  }
}

export type BroadcastCycleMessage = {
  type: 'cycle'
  authMode: AuthMode
  outcome: CycleOutcome
}

/**
 * Cross-tab broadcast acceptance. A tab applies another tab's cycle outcome
 * only when the shape is right and the collecting tab's auth mode matches
 * this tab's. 'auth-rejected' is NEVER applied cross-tab: tokens are per-tab
 * credentials, and another tab's bad token must not clear this tab's valid
 * one or flip it to anonymous.
 */
export function shouldApplyBroadcast(
  msg: unknown,
  localAuthMode: AuthMode,
): msg is BroadcastCycleMessage {
  if (msg === null || typeof msg !== 'object') return false
  const m = msg as Partial<BroadcastCycleMessage> & { type?: unknown }
  if (m.type !== 'cycle') return false
  if (m.authMode !== 'anonymous' && m.authMode !== 'token') return false
  if (m.authMode !== localAuthMode) return false
  if (m.outcome === null || typeof m.outcome !== 'object') return false
  const status = (m.outcome as Partial<CycleOutcome>).status
  if (status !== 'complete' && status !== 'partial' && status !== 'rate-limited' && status !== 'network-error') {
    return false // 'auth-rejected' and unknown statuses stay tab-local
  }
  return true
}
