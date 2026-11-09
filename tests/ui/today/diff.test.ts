import { describe, expect, test } from 'bun:test'
import { diffSnapshots } from '../../../src/today/diff'
import type { TodayPr, TodaySnapshot } from '../../../src/today/normalize'
import { ASSETS_ROSTER, ASSETS_TEAM_SLUG } from '../../../src/today/config'

const MEMBER = ASSETS_ROSTER[0]!

function pr(overrides: Partial<TodayPr>): TodayPr {
  return {
    repo: 'MetaMask/core',
    number: 1,
    title: 't',
    url: 'https://github.com/MetaMask/core/pull/1',
    author: 'x',
    draft: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    labels: [],
    requestedTeams: [],
    requestedReviewers: [],
    ...overrides,
  }
}

function snap(partial: Partial<TodaySnapshot> & { prs: TodayPr[] }): TodaySnapshot {
  return {
    schemaVersion: 1,
    collectedAt: '2026-11-07T12:00:00Z',
    authMode: 'anonymous',
    repos: [],
    complete: true,
    partialReason: null,
    rate: null,
    droppedMalformed: 0,
    checksStoppedReason: null,
    missingChecks: [],
    ...partial,
  }
}

describe('diffSnapshots — per-view new/left', () => {
  test('new PRs and left PRs are counted per view, not mixed', () => {
    const baseline = snap({
      collectedAt: '2026-11-06T00:00:00Z',
      prs: [
        pr({ number: 1, requestedTeams: [ASSETS_TEAM_SLUG] }), // needs @baseline
        pr({ number: 2, author: MEMBER }), // awaiting @baseline
        pr({ number: 3, author: MEMBER, requestedTeams: [ASSETS_TEAM_SLUG] }), // both
      ],
    })
    const current = snap({
      prs: [
        pr({ number: 5, requestedTeams: [ASSETS_TEAM_SLUG] }), // new needs
        pr({ number: 2, author: MEMBER }), // stayed awaiting
        pr({ number: 6, author: MEMBER }), // new awaiting
      ],
    })
    const d = diffSnapshots(baseline, current)
    expect(d.needs.newCount).toBe(1) // #5
    expect(d.needs.left.map((l) => l.number)).toEqual([1, 3])
    expect(d.awaiting.newCount).toBe(1) // #6
    expect(d.awaiting.left.map((l) => l.number)).toEqual([3])
  })

  test('baseline timestamp is carried through, never re-invented', () => {
    const d = diffSnapshots(
      snap({ collectedAt: '2026-11-05T09:30:00Z', prs: [] }),
      snap({ prs: [] }),
    )
    expect(d.baselineCollectedAt).toBe('2026-11-05T09:30:00Z')
  })
})

describe('missing PRs are never silently merged', () => {
  const baseline = snap({
    collectedAt: '2026-11-06T00:00:00Z',
    prs: [pr({ number: 10, requestedTeams: [ASSETS_TEAM_SLUG] })],
  })

  test('verified MERGED state (merged_at) labels merged', () => {
    const current = snap({
      prs: [],
      missingChecks: [{ repo: 'MetaMask/core', number: 10, state: 'MERGED' }],
    })
    expect(diffSnapshots(baseline, current).needs.left[0]?.outcome).toBe('merged')
  })

  test('verified CLOSED state labels closed-without-merging', () => {
    const current = snap({
      prs: [],
      missingChecks: [{ repo: 'MetaMask/core', number: 10, state: 'CLOSED' }],
    })
    expect(diffSnapshots(baseline, current).needs.left[0]?.outcome).toBe('closed')
  })

  test('verified-open but absent from the sweep is unverified (contradictory evidence)', () => {
    // The sweep lists open PRs; a verified-open PR missing from a COMPLETE
    // sweep means the data does not add up. Honest label: unverified —
    // never "left the queue" and never silently merged.
    const current = snap({
      prs: [],
      missingChecks: [{ repo: 'MetaMask/core', number: 10, state: 'OPEN' }],
    })
    expect(diffSnapshots(baseline, current).needs.left[0]?.outcome).toBe('unverified')
  })

  test('unverified and unknown states label unverified, never guess', () => {
    const noCheck = snap({ prs: [] })
    expect(diffSnapshots(baseline, noCheck).needs.left[0]?.outcome).toBe('unverified')
    const unknown = snap({
      prs: [],
      missingChecks: [{ repo: 'MetaMask/core', number: 10, state: 'unknown' }],
    })
    expect(diffSnapshots(baseline, unknown).needs.left[0]?.outcome).toBe('unverified')
  })

  test('an OPEN PR still in the sweep left the needs view because the request is gone', () => {
    const current = snap({
      prs: [pr({ number: 10 })], // open but no longer requested
      missingChecks: [{ repo: 'MetaMask/core', number: 10, state: 'OPEN' }],
    })
    expect(diffSnapshots(baseline, current).needs.left[0]?.outcome).toBe('left-queue')
  })

  test('still-open-and-in-sweep PR with NO detail check still labels left-queue, not unverified', () => {
    // The most common real departure: request removed, PR still open. The PR
    // being in the current sweep is itself proof it is open — no detail
    // check needed to say it left the needs queue without merging.
    const current = snap({
      prs: [pr({ number: 10 })], // open, no review request, no missingChecks
      missingChecks: [],
    })
    expect(diffSnapshots(baseline, current).needs.left[0]?.outcome).toBe('left-queue')
    // A PR absent from the sweep entirely (no check, not visible) is still
    // unverified — disappearance is never silently equated with merging.
    const vanished = snap({ prs: [], missingChecks: [] })
    expect(diffSnapshots(baseline, vanished).needs.left[0]?.outcome).toBe('unverified')
  })

  test('awaiting view stays unverified when an open team PR is somehow unqueued (roster drift)', () => {
    const base = snap({
      collectedAt: '2026-11-06T00:00:00Z',
      prs: [pr({ number: 10, author: MEMBER })],
    })
    const current = snap({
      prs: [pr({ number: 10, author: MEMBER })], // still queued — not left
      missingChecks: [],
    })
    expect(diffSnapshots(base, current).awaiting.left.length).toBe(0)
    const currentGone = snap({
      prs: [],
      missingChecks: [{ repo: 'MetaMask/core', number: 10, state: 'OPEN' }],
    })
    // Verified OPEN but absent from a complete sweep = contradictory
    // evidence — unverified, never a fabricated "left the queue".
    expect(diffSnapshots(base, currentGone).awaiting.left[0]?.outcome).toBe('unverified')
  })
})

describe('drafts are excluded from both queues — honestly', () => {
  test('a PR that became a draft left the queue but is never called merged or closed', () => {
    // Baseline: non-draft team PR with a member request (in both queues).
    const baseline = snap({
      collectedAt: '2026-11-06T00:00:00Z',
      prs: [pr({ number: 20, author: MEMBER, requestedReviewers: [MEMBER] })],
    })
    // Current sweep still lists it (GitHub state=open includes drafts) but
    // it is now a draft → excluded from both current queues.
    const current = snap({
      prs: [pr({ number: 20, author: MEMBER, requestedReviewers: [MEMBER], draft: true })],
      missingChecks: [{ repo: 'MetaMask/core', number: 20, state: 'OPEN' }],
    })
    const d = diffSnapshots(baseline, current)
    expect(d.needs.left).toHaveLength(1)
    expect(d.awaiting.left).toHaveLength(1)
    // Still open (verified) — draft exclusion is a queue change, NOT a
    // merge/close claim.
    expect(d.needs.left[0]?.outcome).toBe('left-queue')
    expect(d.awaiting.left[0]?.outcome).toBe('left-queue')
  })

  test('turned-draft PR with NO detail check still labels left-queue via sweep membership', () => {
    // Realistic collection path: the draft stays in the open-PR sweep (so it
    // is verifiably open by membership) and the bounded check budget never
    // produced a missingChecks entry for it. Draft exclusion is still just a
    // queue exit — never a merge/close claim, never "unverified".
    const baseline = snap({
      collectedAt: '2026-11-06T00:00:00Z',
      prs: [pr({ number: 20, author: MEMBER, requestedReviewers: [MEMBER] })],
    })
    const current = snap({
      prs: [pr({ number: 20, author: MEMBER, requestedReviewers: [MEMBER], draft: true })],
      missingChecks: [],
    })
    const d = diffSnapshots(baseline, current)
    expect(d.awaiting.left[0]?.outcome).toBe('left-queue')
    expect(d.needs.left[0]?.outcome).toBe('left-queue')
  })

  test('a draft in the baseline cache never enters the queues (no draft resurrection)', () => {
    // A cached baseline collected by an older build can contain drafts; the
    // diff must recompute queue membership with current rules.
    const baseline = snap({
      collectedAt: '2026-11-06T00:00:00Z',
      prs: [
        pr({ number: 21, draft: true, author: MEMBER }),
        pr({ number: 22, draft: true, requestedTeams: [ASSETS_TEAM_SLUG] }),
      ],
    })
    const current = snap({ prs: [] })
    const d = diffSnapshots(baseline, current)
    expect(d.needs.left).toHaveLength(0)
    expect(d.awaiting.left).toHaveLength(0)
    expect(d.needs.newCount).toBe(0)
    expect(d.awaiting.newCount).toBe(0)
  })
})
