import { describe, expect, test } from 'bun:test'
import { buildRows, viewCounts } from '../../../src/today/table'
import { ASSETS_ROSTER, ASSETS_TEAM_SLUG } from '../../../src/today/config'
import type { TodayPr } from '../../../src/today/normalize'
import type { TableQuery } from '../../../src/today/table'

const MEMBER = ASSETS_ROSTER[0]!
const NOW = Date.parse('2026-11-07T12:00:00Z')

function pr(overrides: Partial<TodayPr>): TodayPr {
  return {
    repo: 'MetaMask/core',
    number: 1,
    title: 't',
    url: 'https://github.com/MetaMask/core/pull/1',
    author: 'x',
    draft: false,
    createdAt: '2026-11-07T00:00:00Z', // ~0.5 days old
    updatedAt: '2026-11-07T00:00:00Z',
    labels: [],
    requestedTeams: [],
    requestedReviewers: [],
    ...overrides,
  }
}

const PRS: TodayPr[] = [
  pr({ number: 11, requestedTeams: [ASSETS_TEAM_SLUG], createdAt: '2026-10-01T00:00:00Z' }), // needs, old (37d)
  pr({ number: 12, requestedReviewers: [MEMBER], createdAt: '2026-11-06T00:00:00Z' }), // needs via member (1d)
  pr({ number: 13, author: MEMBER, createdAt: '2026-11-05T00:00:00Z', repo: 'MetaMask/metamask-mobile' }), // team (2d)
  pr({ number: 14, author: 'external' }), // neither view
  pr({ number: 15, author: MEMBER, requestedTeams: [ASSETS_TEAM_SLUG, 'core-platform'], createdAt: '2026-11-02T00:00:00Z' }), // both views (5d)
  // Drafts: would qualify for a view if drafts were listed — they must not be.
  pr({ number: 16, draft: true, requestedTeams: [ASSETS_TEAM_SLUG] }), // draft + team request
  pr({ number: 17, draft: true, author: MEMBER }), // draft + team-authored
  pr({ number: 18, draft: true, author: 'external' }), // draft, neither view anyway
]

function query(patch: Partial<TableQuery>): TableQuery {
  return { view: 'needs', repo: null, author: 'all', group: 'none', sort: 'oldest', ...patch }
}

describe('buildRows — view membership', () => {
  test('needs view: only explicit requests on non-drafts, oldest first by default', () => {
    const rows = buildRows(PRS, query({ view: 'needs' }), NOW)
    expect(rows[0]!.rows.map((r) => r.pr.number)).toEqual([11, 15, 12]) // 37d, 5d, 1d
    expect(rows[0]!.rows[0]!.ageDays).toBe(37)
  })

  test('team view: only team-authored non-drafts', () => {
    const rows = buildRows(PRS, query({ view: 'awaiting' }), NOW)
    expect(rows[0]!.rows.map((r) => r.pr.number)).toEqual([15, 13]) // 5d, 2d
  })

  test('viewCounts matches view sizes before filtering, drafts excluded', () => {
    expect(viewCounts(PRS)).toEqual({ needs: 3, awaiting: 2 })
  })
})

describe('buildRows — filters', () => {
  test('repo filter narrows to one repository', () => {
    const rows = buildRows(PRS, query({ view: 'awaiting', repo: 'MetaMask/metamask-mobile' }), NOW)
    expect(rows[0]!.rows.map((r) => r.pr.number)).toEqual([13])
  })

  test('authorship filter applies to the needs view only', () => {
    const internal = buildRows(PRS, query({ author: 'internal' }), NOW)
    expect(internal[0]!.rows.map((r) => r.pr.number)).toEqual([15]) // #11/#12 are external
    const external = buildRows(PRS, query({ author: 'external' }), NOW)
    expect(external[0]!.rows.map((r) => r.pr.number)).toEqual([11, 12])
    // Team view ignores the author filter (all rows are internal there).
    const awaiting = buildRows(PRS, query({ view: 'awaiting', author: 'external' }), NOW)
    expect(awaiting[0]!.rows.length).toBe(2)
  })

  test('drafts stay excluded under every filter combination', () => {
    // Even an explicit author/repo/group/sort combination must not let a
    // draft back in — URL filters can only narrow, never widen, the queues.
    for (const author of ['all', 'internal', 'external'] as const) {
      for (const repo of [null, 'MetaMask/core', 'MetaMask/metamask-mobile'] as const) {
        const needs = buildRows(PRS, query({ view: 'needs', author, repo, group: 'repo', sort: 'newest' }), NOW)
        const team = buildRows(PRS, query({ view: 'awaiting', author, repo, group: 'team', sort: 'author' }), NOW)
        const numbers = [...needs, ...team].flatMap((g) => g.rows.map((r) => r.pr.number))
        expect(numbers).not.toContain(16)
        expect(numbers).not.toContain(17)
        expect(numbers).not.toContain(18)
      }
    }
  })
})

describe('buildRows — sorting', () => {
  test('newest first inverts age order', () => {
    const rows = buildRows(PRS, query({ sort: 'newest' }), NOW)
    expect(rows[0]!.rows.map((r) => r.pr.number)).toEqual([12, 15, 11]) // 0d? #12=1d, #15=5d, #11=37d
  })

  test('repo sort orders Core, Mobile, Extension canonically', () => {
    const rows = buildRows(PRS, query({ sort: 'repo' }), NOW)
    expect(rows[0]!.rows.map((r) => r.pr.repo)).toEqual([
      'MetaMask/core',
      'MetaMask/core',
      'MetaMask/core',
    ])
    const mobile = buildRows(PRS, query({ view: 'awaiting', sort: 'repo' }), NOW)
    expect(mobile[0]!.rows.map((r) => r.pr.repo)).toEqual(['MetaMask/core', 'MetaMask/metamask-mobile'])
  })

  test('author sort is alphabetical with age tiebreak', () => {
    const rows = buildRows(PRS, query({ view: 'awaiting', sort: 'author' }), NOW)
    expect(rows[0]!.rows.map((r) => r.pr.author)).toEqual([MEMBER, MEMBER])
  })
})

describe('buildRows — grouping', () => {
  test('repo grouping produces one group per repository in canonical order', () => {
    const groups = buildRows(PRS, query({ view: 'awaiting', group: 'repo' }), NOW)
    expect(groups.map((g) => g.groupKey)).toEqual(['MetaMask/core', 'MetaMask/metamask-mobile'])
    expect(groups[1]!.rows.map((r) => r.pr.number)).toEqual([13])
  })

  test('team grouping keys on requested team slugs, multi-team PRs join one key', () => {
    const groups = buildRows(PRS, query({ group: 'team' }), NOW)
    expect(groups.map((g) => g.groupKey)).toEqual([
      'core-platform, metamask-assets',
      'metamask-assets',
      'No team request',
    ])
    expect(groups[0]!.rows.map((r) => r.pr.number)).toEqual([15])
    expect(groups[1]!.rows.map((r) => r.pr.number)).toEqual([11])
    expect(groups[2]!.rows.map((r) => r.pr.number)).toEqual([12])
  })

  test('none grouping yields a single All group', () => {
    const groups = buildRows(PRS, query({ group: 'none' }), NOW)
    expect(groups.length).toBe(1)
    expect(groups[0]!.groupKey).toBe('All')
    expect(groups[0]!.rows.length).toBe(3)
  })
})
