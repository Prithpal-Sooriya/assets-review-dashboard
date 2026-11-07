/**
 * Since-yesterday comparison between a usable baseline snapshot and the
 * current snapshot.
 *
 * Honesty rules (spec):
 *  - The comparison only exists when THIS browser retained a suitable
 *    baseline; the card always shows the baseline's actual timestamp.
 *  - A PR missing from the current queue is NOT assumed merged. The sweep's
 *    bounded missing-PR state checks classify some as MERGED/CLOSED/still
 *    open ("left review queue"); everything beyond the bounded check budget
 *    is labelled unverified, never guessed.
 *  - Diffs are computed per view (needs review / awaiting others) so each
 *    number answers exactly one question.
 */

import { assetsAuthored, needsAssetsReview } from './classify'
import { prId, type TodaySnapshot } from './normalize'

export interface LeftEntry {
  repo: string
  number: number
  title: string
  url: string
  /** MERGED/CLOSED/OPEN from a bounded state check; 'left-queue' when the PR
   *  is open but no longer requested; 'unverified' when no check was run. */
  outcome: 'merged' | 'closed' | 'left-queue' | 'unverified'
}

export interface ViewDiff {
  newCount: number
  /** New entries (title/url shown so the change is inspectable). */
  left: LeftEntry[]
}

export interface SinceDiff {
  baselineCollectedAt: string
  needs: ViewDiff
  awaiting: ViewDiff
}

function keySet(prs: ReturnType<typeof queueOf>): Set<string> {
  return new Set(prs.map(prId))
}

function queueOf(snap: TodaySnapshot, view: 'needs' | 'awaiting') {
  return snap.prs.filter(view === 'needs' ? needsAssetsReview : assetsAuthored)
}

function outcomeFor(
  repo: string,
  number: number,
  checks: TodaySnapshot['missingChecks'],
  currentOpen: Set<string>,
): LeftEntry['outcome'] {
  const checked = checks.find((c) => c.repo === repo && c.number === number)
  if (checked !== undefined) {
    if (checked.state === 'MERGED') return 'merged'
    if (checked.state === 'CLOSED') return 'closed'
    if (checked.state === 'unknown') return 'unverified'
    // checked.state === 'OPEN': verified still open — fall through.
  }
  // Still open (verified, or by sweep membership: the sweep lists open PRs).
  // Present in the current sweep → it left this view's QUEUE (review request
  // removed, or the author is no longer on the roster) — not GitHub.
  // Absent from a complete sweep entirely → contradictory evidence (an open
  // PR cannot be missing from an open-PR sweep): unverified, never silently
  // "left" and never silently merged.
  return currentOpen.has(`${repo}#${number}`) ? 'left-queue' : 'unverified'
}

/** Compute the per-view since-baseline diff. */
export function diffSnapshots(baseline: TodaySnapshot, current: TodaySnapshot): SinceDiff {
  const currentOpen = new Set(current.prs.map(prId))

  const viewDiff = (view: 'needs' | 'awaiting'): ViewDiff => {
    const baseQueue = queueOf(baseline, view)
    const curQueue = queueOf(current, view)
    const baseKeys = keySet(baseQueue)
    const curKeys = keySet(curQueue)

    const added = curQueue
      .filter((pr) => !baseKeys.has(prId(pr)))
      .map((pr) => ({ repo: pr.repo, number: pr.number, title: pr.title, url: pr.url }))

    const left: LeftEntry[] = baseQueue
      .filter((pr) => !curKeys.has(prId(pr)))
      .map((pr) => ({
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        outcome: outcomeFor(pr.repo, pr.number, current.missingChecks, currentOpen),
      }))
      // Oldest PR numbers first — the most interesting departures surface early.
      .sort((a, b) => a.number - b.number)

    return { newCount: added.length, left }
  }

  return {
    baselineCollectedAt: baseline.collectedAt,
    needs: viewDiff('needs'),
    awaiting: viewDiff('awaiting'),
  }
}
