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
    expect(d.needs.added.map((a) => a.number)).toEqual([5])
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

  test('still-open-but-not-requested labels left-queue (disappearance ≠ merge)', () => {
    const current = snap({
      prs: [],
      missingChecks: [{ repo: 'MetaMask/core', number: 10, state: 'OPEN' }],
    })
    expect(diffSnapshots(baseline, current).needs.left[0]?.outcome).toBe('left-queue')
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
    expect(diffSnapshots(base, currentGone).awaiting.left[0]?.outcome).toBe('left-queue')
  })
})
