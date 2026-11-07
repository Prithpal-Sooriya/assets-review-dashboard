import { describe, expect, test } from 'bun:test'
import { isTodaySnapshot, normalizePull, sanitizeSnapshot } from '../../../src/today/normalize'
import type { RawPull } from '../../../src/today/github'
import type { TodaySnapshot } from '../../../src/today/normalize'

function raw(overrides: Partial<RawPull> = {}): RawPull {
  return {
    number: 42,
    title: 'A PR title',
    html_url: 'https://github.com/MetaMask/core/pull/42',
    draft: false,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-06T00:00:00Z',
    user: { login: 'somebody' },
    labels: [{ name: 'bug' }],
    requested_reviewers: [{ login: 'reviewer-a' }],
    requested_teams: [{ slug: 'metamask-assets' }],
    ...overrides,
  }
}

describe('normalizePull — strict public-field normalization', () => {
  test('maps raw fields to the normalized shape', () => {
    const pr = normalizePull('MetaMask/core', raw())
    expect(pr).toEqual({
      repo: 'MetaMask/core',
      number: 42,
      title: 'A PR title',
      url: 'https://github.com/MetaMask/core/pull/42',
      author: 'somebody',
      draft: false,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-06T00:00:00Z',
      labels: ['bug'],
      requestedTeams: ['metamask-assets'],
      requestedReviewers: ['reviewer-a'],
    })
  })

  test('null list fields degrade to empty arrays (anonymous API hides nothing here)', () => {
    const pr = normalizePull(
      'MetaMask/core',
      raw({ labels: null, requested_reviewers: null, requested_teams: null, user: null }),
    )
    expect(pr).not.toBeNull()
    expect(pr!.labels).toEqual([])
    expect(pr!.requestedTeams).toEqual([])
    expect(pr!.requestedReviewers).toEqual([])
    expect(pr!.author).toBe('unknown')
  })

  test('malformed core fields return null (counted as dropped by the collector)', () => {
    expect(normalizePull('MetaMask/core', raw({ number: 'forty-two' as unknown as number }))).toBeNull()
    expect(normalizePull('MetaMask/core', raw({ created_at: 'yesterday-ish' }))).toBeNull()
    // A garbled author degrades to 'unknown' rather than dropping the PR.
    const garbled = normalizePull('MetaMask/core', raw({ user: { login: 'x'.repeat(200) } }))
    expect(garbled?.author).toBe('unknown')
  })

  test('PR URLs must be genuine github.com pull URLs — never rendered otherwise', () => {
    expect(normalizePull('MetaMask/core', raw({ html_url: 'javascript:alert(1)' }))).toBeNull()
    expect(normalizePull('MetaMask/core', raw({ html_url: 'https://evil.example.com/pull/42' }))).toBeNull()
    expect(normalizePull('MetaMask/core', raw({ html_url: 'https://github.com/MetaMask/core/issues/42' }))).toBeNull()
    expect(normalizePull('MetaMask/core', raw({ html_url: 'https://github.com/MetaMask/core/pull/42/files' }))).toBeNull()
    expect(normalizePull('MetaMask/core', raw({ html_url: 'https://github.com/MetaMask/core/pull/42' }))).not.toBeNull()
  })

  test('title/label/summary length caps are enforced', () => {
    const long = 'x'.repeat(400)
    expect(normalizePull('MetaMask/core', raw({ title: long }))).toBeNull()
    const pr = normalizePull(
      'MetaMask/core',
      raw({ labels: Array.from({ length: 30 }, (_, i) => ({ name: `l${i}` })) }),
    )
    expect(pr).not.toBeNull()
    expect(pr!.labels.length).toBeLessThanOrEqual(10)
  })
})

describe('isTodaySnapshot — cache validation', () => {
  test('accepts a well-formed snapshot', () => {
    const snap = {
      schemaVersion: 1,
      collectedAt: '2026-11-08T12:00:00Z',
      authMode: 'anonymous',
      repos: [],
      complete: true,
      partialReason: null,
      rate: null,
      droppedMalformed: 0,
      missingChecks: [],
      prs: [],
    }
    expect(isTodaySnapshot(snap)).toBe(true)
  })

  test('rejects wrong schema versions and non-objects', () => {
    expect(isTodaySnapshot(null)).toBe(false)
    expect(isTodaySnapshot('nope')).toBe(false)
    expect(isTodaySnapshot({ schemaVersion: 2, collectedAt: 'x' })).toBe(false)
    expect(isTodaySnapshot({ schemaVersion: 1 })).toBe(false) // missing fields
  })
})

/* ------------------------------------------------------------------ */
/* sanitizeSnapshot — untrusted input revalidation (IDB or broadcast)  */
/* ------------------------------------------------------------------ */

function storedSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const pr = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    repo: 'MetaMask/core',
    number: 7,
    title: 'Fix thing',
    url: 'https://github.com/MetaMask/core/pull/7',
    author: 'someone',
    draft: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    labels: [],
    requestedTeams: [],
    requestedReviewers: [],
    ...over,
  })
  return {
    schemaVersion: 1,
    collectedAt: '2026-11-08T12:00:00Z',
    authMode: 'anonymous',
    repos: [],
    complete: true,
    partialReason: null,
    rate: null,
    droppedMalformed: 0,
    missingChecks: [],
    prs: [pr()],
    ...overrides,
  }
}

describe('sanitizeSnapshot — revalidate snapshots from IndexedDB or broadcasts', () => {
  test('a clean snapshot round-trips unchanged', () => {
    const clean = storedSnapshot()
    expect(sanitizeSnapshot(clean)).toEqual(clean as unknown as TodaySnapshot)
  })

  test('null / non-object / wrong schema → null (never rendered)', () => {
    expect(sanitizeSnapshot(null)).toBeNull()
    expect(sanitizeSnapshot(undefined)).toBeNull()
    expect(sanitizeSnapshot('snapshot')).toBeNull()
    expect(sanitizeSnapshot({ schemaVersion: 99 })).toBeNull()
  })

  test('a PR with a javascript: href is dropped, never reaches <a href>', () => {
    const out = sanitizeSnapshot(
      storedSnapshot({
        prs: [
          { repo: 'MetaMask/core', number: 1, title: 'evil', url: 'javascript:alert(1)', author: 'x', draft: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', labels: [], requestedTeams: [], requestedReviewers: [] },
          { repo: 'MetaMask/core', number: 2, title: 'good', url: 'https://github.com/MetaMask/core/pull/2', author: 'x', draft: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', labels: [], requestedTeams: [], requestedReviewers: [] },
        ],
      }),
    )
    expect(out?.prs).toHaveLength(1)
    expect(out?.prs[0]?.number).toBe(2)
    expect(out?.droppedMalformed).toBe(1)
  })

  test('a PR with an invalid/missing date or non-https origin is dropped', () => {
    const badDate = sanitizeSnapshot(
      storedSnapshot({
        prs: [
          { repo: 'MetaMask/core', number: 3, title: 'bad date', url: 'https://github.com/MetaMask/core/pull/3', author: 'x', draft: false, createdAt: 'not-a-date', updatedAt: '2026-11-01T00:00:00Z', labels: [], requestedTeams: [], requestedReviewers: [] },
        ],
      }),
    )
    expect(badDate?.prs).toHaveLength(0)
    expect(badDate?.droppedMalformed).toBe(1)

    const httpOrigin = sanitizeSnapshot(
      storedSnapshot({
        prs: [
          { repo: 'MetaMask/core', number: 4, title: 'http', url: 'http://github.com/MetaMask/core/pull/4', author: 'x', draft: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', labels: [], requestedTeams: [], requestedReviewers: [] },
        ],
      }),
    )
    expect(httpOrigin?.prs).toHaveLength(0)
    expect(httpOrigin?.droppedMalformed).toBe(1)
  })

  test('extra injected fields on PRs are stripped (only known public fields kept)', () => {
    const out = sanitizeSnapshot(
      storedSnapshot({
        prs: [
          { repo: 'MetaMask/core', number: 5, title: 'ok', url: 'https://github.com/MetaMask/core/pull/5', author: 'x', draft: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', labels: [], requestedTeams: [], requestedReviewers: [], injectedSecret: 'ghp_x' },
        ],
      }),
    )
    expect(out?.prs[0]).not.toHaveProperty('injectedSecret')
  })

  test('missing-check entries with forged states are dropped', () => {
    const out = sanitizeSnapshot(
      storedSnapshot({
        missingChecks: [
          { repo: 'MetaMask/core', number: 7, state: 'MERGED' },
          { repo: 'MetaMask/core', number: 8, state: 'MASS-MERGED' },
          { repo: 'MetaMask/core', number: 9, state: 42 },
        ],
      }),
    )
    expect(out?.missingChecks).toEqual([{ repo: 'MetaMask/core', number: 7, state: 'MERGED' }])
  })

  test('a non-array prs / missingChecks shape → null (never half-rendered)', () => {
    expect(sanitizeSnapshot(storedSnapshot({ prs: 'none' }))).toBeNull()
    expect(sanitizeSnapshot(storedSnapshot({ missingChecks: null }))).toBeNull()
  })
})
