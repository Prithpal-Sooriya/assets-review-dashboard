import { describe, expect, test } from 'bun:test'
import {
  ASSETS_ROSTER,
  ASSETS_TEAM_SLUG,
} from '../../../src/today/config'
import {
  assetsAuthored,
  authorshipOf,
  awaitingInfoOf,
  formatAge,
  hasMemberRequest,
  hasTeamRequest,
  needsAssetsReview,
  nextActionOf,
  prAgeDays,
  requestedKindOf,
} from '../../../src/today/classify'
import type { TodayPr } from '../../../src/today/normalize'

const NOW = Date.parse('2026-11-07T12:00:00Z')

function pr(overrides: Partial<TodayPr> = {}): TodayPr {
  return {
    repo: 'MetaMask/core',
    number: 100,
    title: 'A title',
    url: 'https://github.com/MetaMask/core/pull/100',
    author: 'someone-external',
    draft: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-06T00:00:00Z',
    labels: [],
    requestedTeams: [],
    requestedReviewers: [],
    ...overrides,
  }
}

describe('needsAssetsReview — explicit requests only', () => {
  test('team request to the Assets slug qualifies', () => {
    const p = pr({ requestedTeams: ['core-platform', ASSETS_TEAM_SLUG] })
    expect(needsAssetsReview(p)).toBe(true)
    expect(hasTeamRequest(p)).toBe(true)
    expect(hasMemberRequest(p)).toBe(false)
  })

  test('direct request to a roster member qualifies', () => {
    const member = ASSETS_ROSTER[0]!
    const p = pr({ requestedReviewers: ['random-person', member] })
    expect(needsAssetsReview(p)).toBe(true)
    expect(hasTeamRequest(p)).toBe(false)
    expect(hasMemberRequest(p)).toBe(true)
  })

  test('ownership label alone never qualifies', () => {
    const p = pr({ labels: ['team-assets', 'Assets'] })
    expect(needsAssetsReview(p)).toBe(false)
  })

  test('internal authorship alone never qualifies (authorship ≠ request)', () => {
    const member = ASSETS_ROSTER[1]!
    const p = pr({ author: member })
    expect(authorshipOf(p)).toBe('internal')
    expect(needsAssetsReview(p)).toBe(false)
  })

  test('requests to other teams or non-members do not qualify', () => {
    expect(needsAssetsReview(pr({ requestedTeams: ['core-platform'] }))).toBe(false)
    expect(needsAssetsReview(pr({ requestedReviewers: ['not-a-member'] }))).toBe(false)
    expect(needsAssetsReview(pr())).toBe(false)
  })

  test('case sensitivity: logins must match exactly', () => {
    const member = ASSETS_ROSTER.find((m) => m !== m.toLowerCase()) ?? 'Prithpal-Sooriya'
    expect(needsAssetsReview(pr({ requestedReviewers: [member.toLowerCase()] }))).toBe(false)
  })
})

describe('assetsAuthored — authorship view', () => {
  test('roster author qualifies regardless of requests or labels', () => {
    const member = ASSETS_ROSTER[2]!
    expect(assetsAuthored(pr({ author: member }))).toBe(true)
    expect(assetsAuthored(pr({ author: 'external' }))).toBe(false)
  })

  test('a PR can be in both views (team-authored AND team-requested)', () => {
    const member = ASSETS_ROSTER[3]!
    const p = pr({ author: member, requestedTeams: [ASSETS_TEAM_SLUG] })
    expect(assetsAuthored(p)).toBe(true)
    expect(needsAssetsReview(p)).toBe(true)
  })
})

describe('awaitingInfoOf — unknown teams stay unknown', () => {
  test('other team slugs are surfaced raw, never mapped or guessed', () => {
    const p = pr({ requestedTeams: [ASSETS_TEAM_SLUG, 'core-platform', 'some-unknown-team'] })
    const info = awaitingInfoOf(p)
    expect(info.otherTeams).toEqual(['core-platform', 'some-unknown-team'])
  })

  test('outside reviewer requests exclude roster members', () => {
    const member = ASSETS_ROSTER[4]!
    const p = pr({ requestedReviewers: [member, 'outsider'] })
    expect(awaitingInfoOf(p).otherReviewers).toEqual(['outsider'])
  })

  test('requestedKindOf distinguishes team/member/both/none', () => {
    expect(requestedKindOf(pr({ requestedTeams: [ASSETS_TEAM_SLUG] }))).toBe('team')
    expect(requestedKindOf(pr({ requestedReviewers: [ASSETS_ROSTER[5]!] }))).toBe('members')
    expect(
      requestedKindOf(pr({ requestedTeams: [ASSETS_TEAM_SLUG], requestedReviewers: [ASSETS_ROSTER[5]!] })),
    ).toBe('team-and-members')
    expect(requestedKindOf(pr())).toBe('none-visible')
  })
})

describe('nextActionOf — simple, honest states', () => {
  test('draft shows author action in both views', () => {
    expect(nextActionOf(pr({ draft: true }), 'needs')).toBe('Draft — author action')
    expect(nextActionOf(pr({ draft: true }), 'awaiting')).toBe('Draft — author action')
  })

  test('needs view says review requested', () => {
    expect(nextActionOf(pr(), 'needs')).toBe('Review requested')
  })

  test('awaiting view names other teams when requested', () => {
    const p = pr({ requestedTeams: ['core-platform'] })
    expect(nextActionOf(p, 'awaiting')).toBe('Awaiting core-platform')
  })

  test('awaiting view with no visible requests stays honest', () => {
    expect(nextActionOf(pr(), 'awaiting')).toBe('No visible requests — check PR')
  })
})

describe('prAgeDays / formatAge', () => {
  test('age is measured from creation, floor to days', () => {
    const p = pr({ createdAt: '2026-11-07T11:59:00Z' })
    expect(prAgeDays(p, NOW)).toBe(0)
    expect(prAgeDays(pr({ createdAt: '2026-10-01T00:00:00Z' }), NOW)).toBe(37)
  })

  test('malformed createdAt degrades to 0, not NaN', () => {
    expect(prAgeDays(pr({ createdAt: 'not-a-date' }), NOW)).toBe(0)
  })

  test('human labels', () => {
    expect(formatAge(0)).toBe('today')
    expect(formatAge(1)).toBe('1 day')
    expect(formatAge(5)).toBe('5 days')
    expect(formatAge(31)).toBe('~1 month')
    expect(formatAge(95)).toBe('~3 months')
  })
})
