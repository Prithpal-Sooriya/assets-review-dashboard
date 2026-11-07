import { describe, expect, test } from 'bun:test'
import { collectCycle, type CycleOutcome } from '../../../src/today/collector'
import { ASSETS_TEAM_SLUG, PULLS_PER_PAGE } from '../../../src/today/config'
import type { RawPull } from '../../../src/today/github'
import type { TodayPr, TodaySnapshot } from '../../../src/today/normalize'

/* ------------------------------------------------------------------ */
/* Fake GitHub API: every response is scripted; every request is      */
/* recorded. No network, no real credentials.                         */
/* ------------------------------------------------------------------ */

interface Served {
  status: number
  headers: Record<string, string>
  body: unknown
}

class FetchRecorder {
  calls: { url: string; auth: string | null; accept: string | null }[] = []
  private script: (url: URL) => Served
  constructor(script: (url: URL) => Served) {
    this.script = script
  }
  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    }
    const url = new URL(input)
    const h = new Headers(init?.headers)
    this.calls.push({ url: url.toString(), auth: h.get('authorization'), accept: h.get('accept') })
    const res = this.script(url)
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: new Headers({ 'content-type': 'application/json', ...res.headers }),
    })
  }
}

function rawPull(overrides: Partial<RawPull> = {}): RawPull {
  return {
    number: 1,
    title: 't',
    html_url: 'https://github.com/x/y/pull/1',
    draft: false,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-06T00:00:00Z',
    user: { login: 'author-login' },
    labels: [],
    requested_reviewers: [],
    requested_teams: [],
    ...overrides,
  }
}

const ANON_RATE = { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '55', 'x-ratelimit-reset': '1799070000' }
const TOKEN_RATE = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4900', 'x-ratelimit-reset': '1799070000' }

const PULLS_PATHS: Record<string, string> = {
  'MetaMask/core': '/repos/MetaMask/core/pulls',
  'MetaMask/metamask-mobile': '/repos/MetaMask/metamask-mobile/pulls',
  'MetaMask/metamask-extension': '/repos/MetaMask/metamask-extension/pulls',
}

const NOW = Date.parse('2026-11-08T12:00:00Z')
const deps = (rec: FetchRecorder, patch: Partial<Parameters<typeof collectCycle>[0]> = {}) => ({
  fetchImpl: rec.fetch as typeof fetch,
  nowMs: () => NOW,
  token: null as string | null,
  signal: new AbortController().signal,
  baseline: null as TodaySnapshot | null,
  ...patch,
})

/** Anonymous happy-path script: one clean short page per repo. */
function happyAnon(overrides: {
  core?: (page: number) => Served
  mobile?: (page: number) => Served
  extension?: (page: number) => Served
  rateLimit?: Served
  detail?: Record<string, Served>
} = {}): (url: URL) => Served {
  return (url) => {
    if (url.pathname === '/rate_limit') {
      return (
        overrides.rateLimit ?? {
          status: 200,
          headers: ANON_RATE,
          body: { resources: { core: { limit: 60, remaining: 55, reset: 1799070000 } } },
        }
      )
    }
    const detail = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(url.pathname)
    if (detail) {
      const key = `${detail[1]}/${detail[2]}#${detail[3]}`
      return overrides.detail?.[key] ?? { status: 200, headers: ANON_RATE, body: { state: 'open', merged_at: null } }
    }
    if (url.pathname === PULLS_PATHS['MetaMask/core']) {
      return overrides.core?.(Number(url.searchParams.get('page'))) ??
        { status: 200, headers: ANON_RATE, body: [rawPull({ number: 1, requested_teams: [{ slug: ASSETS_TEAM_SLUG }] })] }
    }
    if (url.pathname === PULLS_PATHS['MetaMask/metamask-mobile']) {
      return overrides.mobile?.(Number(url.searchParams.get('page'))) ??
        { status: 200, headers: ANON_RATE, body: [rawPull({ number: 2 })] }
    }
    if (url.pathname === PULLS_PATHS['MetaMask/metamask-extension']) {
      return overrides.extension?.(Number(url.searchParams.get('page'))) ??
        { status: 200, headers: ANON_RATE, body: [rawPull({ number: 3 })] }
    }
    return { status: 404, headers: ANON_RATE, body: { message: 'Not Found' } }
  }
}

const nextPage = (items: RawPull[]): Served => ({
  status: 200,
  headers: {
    ...ANON_RATE,
    link: `<https://api.github.com/repos/x/y/pulls?page=PLACEHOLDER>; rel="next"`,
  },
  body: items,
})

describe('collectCycle — complete anonymous sweep', () => {
  test('collects all repos, classifies team requests, sends no auth header', async () => {
    const rec = new FetchRecorder(happyAnon())
    const out = await collectCycle(deps(rec))
    expect(out.status).toBe('complete')
    expect(out.requestsUsed).toBe(3)
    expect(rec.calls.length).toBe(4) // pre-flight + 3 repo pages
    expect(rec.calls.every((c) => c.auth === null)).toBe(true)
    expect(rec.calls.every((c) => c.accept === 'application/vnd.github+json')).toBe(true)
    const snap = out.snapshot
    expect(snap?.complete).toBe(true)
    expect(snap?.authMode).toBe('anonymous')
    expect(snap?.prs.length).toBe(3)
    expect(snap?.prs.filter((p) => p.requestedTeams.includes(ASSETS_TEAM_SLUG)).map((p) => p.number)).toEqual([1])
    expect(snap?.rate?.remaining).toBe(55)
    expect(snap?.repos.every((r) => r.complete)).toBe(true)
  })
})

describe('collectCycle — pagination', () => {
  test('follows full pages via rel="next", stops on a short page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => rawPull({ number: i + 1 }))
    const short = [rawPull({ number: 101 })]
    const rec = new FetchRecorder(
      happyAnon({
        core: (page) => (page === 1 ? nextPage(full) : { status: 200, headers: ANON_RATE, body: short }),
      }),
    )
    const out = await collectCycle(deps(rec))
    expect(out.status).toBe('complete')
    expect(out.requestsUsed).toBe(4)
    expect(out.snapshot?.prs.length).toBe(103) // 100 + 1 core pages + mobile 1 + extension 1
    expect(new URL(rec.calls[1]!.url).searchParams.get('page')).toBe('1')
    expect(new URL(rec.calls[2]!.url).searchParams.get('page')).toBe('2')
  })

  test('partial page with a next link does NOT paginate further (GitHub semantics)', async () => {
    const rec = new FetchRecorder(
      happyAnon({ core: () => nextPage([rawPull({ number: 7 })]) }),
    )
    const out = await collectCycle(deps(rec))
    expect(out.status).toBe('complete')
    expect(out.requestsUsed).toBe(3)
    expect(out.snapshot?.prs.length).toBe(3)
  })

  test('duplicate numbers across full pages are de-duplicated', async () => {
    const p1 = Array.from({ length: 100 }, (_, i) => rawPull({ number: i + 1 }))
    const p2 = Array.from({ length: 100 }, (_, i) => rawPull({ number: i + 100 })) // #100 twice
    const rec = new FetchRecorder(
      happyAnon({
        core: (page) =>
          page === 1
            ? nextPage(p1)
            : { status: 200, headers: ANON_RATE, body: p2 },
      }),
    )
    const out = await collectCycle(deps(rec))
    expect(out.status).toBe('complete')
    const core = out.snapshot?.prs.filter((p) => p.repo === 'MetaMask/core') ?? []
    expect(core.length).toBe(199)
    expect(new Set(core.map((p) => p.number)).size).toBe(core.length)
  })
})

describe('collectCycle — caps and budget guards', () => {
  test('per-repo page cap truncates and marks the snapshot partial, other repos still sweep', async () => {
    const pageOf = (page: number) => Array.from({ length: 100 }, (_, i) => rawPull({ number: (page - 1) * 100 + i + 1 }))
    const rec = new FetchRecorder(
      happyAnon({ core: (page) => nextPage(pageOf(page)) }), // endless pages
    )
    const out = await collectCycle(deps(rec))
    expect(out.status).toBe('partial')
    expect(out.snapshot?.complete).toBe(false)
    expect(out.snapshot?.partialReason).toBe('page-cap')
    expect(out.requestsUsed).toBe(10) // 8 capped core pages + mobile + extension
    const core = out.snapshot?.prs.filter((p) => p.repo === 'MetaMask/core') ?? []
    expect(core.length).toBe(800)
    expect(out.snapshot?.repos[0]).toEqual({ repo: 'MetaMask/core', pagesFetched: 8, complete: false })
    expect(out.snapshot?.repos[1]?.complete).toBe(true)
  })

  test('remaining floor aborts mid-sweep and preserves already-fetched pages', async () => {
    // Remaining counts down 22, 19, 16, 13, 10 — allow() blocks at ≤ 10.
    let n = 0
    const rec = new FetchRecorder(
      happyAnon({
        core: () => {
          n += 1
          const full = Array.from({ length: 100 }, (_, i) => rawPull({ number: n * 100 + i }))
          return {
            ...nextPage(full),
            headers: {
              ...ANON_RATE,
              link: '<https://api.github.com/repos/MetaMask/core/pulls?page=2>; rel="next"',
              'x-ratelimit-remaining': String(25 - n * 3),
            },
          }
        },
      }),
    )
    const out = await collectCycle(deps(rec))
    expect(out.status).toBe('partial')
    expect(out.snapshot?.partialReason).toBe('rate-limit')
    expect(out.requestsUsed).toBe(5)
    expect(out.retryAtMs).toBe(NOW + 60_000)
    expect(out.snapshot?.prs.length).toBe(500)
  })

  test('403 with exhausted rate headers is partial rate-limit with reset hint', async () => {
    const rec = new FetchRecorder(
      happyAnon({
        mobile: () => ({
          status: 403,
          headers: { ...ANON_RATE, 'x-ratelimit-remaining': '0' },
          body: { message: 'API rate limit exceeded' },
        }),
      }),
    )
    const out = await collectCycle(deps(rec))
    expect(out.status).toBe('partial')
    expect(out.snapshot?.partialReason).toBe('rate-limit')
    expect(out.retryAtMs).toBe(1_799_070_000_000) // reset 1799070000s in ms
    expect(out.snapshot?.prs.length).toBe(1) // core page kept
  })

  test('anonymous pre-flight with insufficient shared budget spends nothing', async () => {
    const rec = new FetchRecorder(
      happyAnon({
        rateLimit: {
          status: 200,
          headers: ANON_RATE,
          body: { resources: { core: { limit: 60, remaining: 8, reset: 1799070000 } } },
        },
      }),
    )
    const out = await collectCycle(deps(rec))
    expect(out.status).toBe('rate-limited')
    expect(out.snapshot).toBeNull()
    expect(out.requestsUsed).toBe(0)
    expect(rec.calls.length).toBe(1) // pre-flight only, no sweep pages
  })

  test('pre-flight network failure is non-fatal (sweep still runs)', async () => {
    const rec = new FetchRecorder((url) => {
      if (url.pathname === '/rate_limit') throw new Error('preflight down')
      return happyAnon()(url)
    })
    const out = await collectCycle(deps(rec))
    expect(out.status).toBe('complete')
    expect(out.requestsUsed).toBe(3)
  })
})

describe('collectCycle — errors', () => {
  test('network failure on the first page: no snapshot, scrubbed message', async () => {
    const rec = new FetchRecorder((url) => {
      if (url.pathname === '/rate_limit') return happyAnon()(url)
      throw new Error('boom-secret-word')
    })
    const out: CycleOutcome = await collectCycle(deps(rec))
    expect(out.status).toBe('network-error')
    expect(out.snapshot).toBeNull()
    expect(out.message).not.toContain('boom-secret-word')
    expect(out.requestsUsed).toBe(1)
  })

  test('401 with a token: auth-rejected, token never leaks anywhere in the outcome', async () => {
    const TOKEN = 'github_pat_TESTTOKEN_LEAKCHECK_42'
    const rec = new FetchRecorder((url) => {
      if (url.pathname === PULLS_PATHS['MetaMask/core']) {
        return { status: 401, headers: TOKEN_RATE, body: { message: 'Bad credentials' } }
      }
      return happyAnon()(url)
    })
    const out = await collectCycle(deps(rec, { token: TOKEN }))
    expect(out.status).toBe('auth-rejected')
    expect(out.snapshot).toBeNull()
    expect(JSON.stringify(out)).not.toContain(TOKEN)
    expect(rec.calls[0]!.auth).toBe(`Bearer ${TOKEN}`)
    expect(rec.calls[0]!.url).not.toContain('token') // never in URLs either
  })

  test('404 repo: partial repo-missing, later repos still collected', async () => {
    const rec = new FetchRecorder(
      happyAnon({
        core: () => ({ status: 404, headers: ANON_RATE, body: { message: 'Not Found' } }),
      }),
    )
    const out = await collectCycle(deps(rec))
    expect(out.status).toBe('partial')
    expect(out.snapshot?.partialReason).toBe('repo-missing')
    expect(out.snapshot?.prs.length).toBe(2) // mobile + extension
    expect(out.requestsUsed).toBe(3)
    expect(out.message).toContain('not found')
  })

  test('aborted signal: aborted outcome, nothing cached', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const rec = new FetchRecorder(happyAnon())
    const out = await collectCycle(deps(rec, { signal: ctrl.signal }))
    expect(out.status).toBe('aborted')
    expect(out.snapshot).toBeNull()
  })
})

describe('collectCycle — token auth', () => {
  test('every request carries the bearer header; auth mode recorded', async () => {
    const TOKEN = 'github_pat_AUTHCHECK_ONLY_LOCAL'
    const script = (url: URL): Served => {
      const base = happyAnon()(url)
      return { ...base, headers: { ...TOKEN_RATE, ...(base.headers.link ? { link: base.headers.link } : {}) } }
    }
    const rec = new FetchRecorder(script)
    const out = await collectCycle(deps(rec, { token: TOKEN }))
    expect(out.status).toBe('complete')
    expect(out.snapshot?.authMode).toBe('token')
    expect(rec.calls.length).toBe(3) // no pre-flight in token mode
    expect(rec.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true)
  })
})

describe('collectCycle — bounded missing-PR checks (missing ≠ merged)', () => {
  function baselinePr(n: number): TodayPr {
    return {
      repo: 'MetaMask/core',
      number: n,
      title: 'old',
      url: `https://github.com/MetaMask/core/pull/${n}`,
      author: 'x',
      draft: false,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      labels: [],
      requestedTeams: [ASSETS_TEAM_SLUG],
      requestedReviewers: [],
    }
  }

  test('verified states recorded; beyond the cap entries stay unchecked (never guessed merged)', async () => {
    const baseline: TodaySnapshot = {
      schemaVersion: 1,
      collectedAt: '2026-11-07T00:00:00Z', // 36h before NOW → usable
      authMode: 'anonymous',
      repos: [],
      complete: true,
      partialReason: null,
      rate: null,
      droppedMalformed: 0,
      missingChecks: [],
      prs: Array.from({ length: 25 }, (_, i) => baselinePr(i + 1)),
    }
    // Current sweep: only #1 still open in core; mobile/extension empty.
    const rec = new FetchRecorder(
      happyAnon({
        core: () => ({ status: 200, headers: ANON_RATE, body: [rawPull({ number: 1 })] }),
        mobile: () => ({ status: 200, headers: ANON_RATE, body: [] }),
        extension: () => ({ status: 200, headers: ANON_RATE, body: [] }),
        detail: {
          'MetaMask/core#2': { status: 200, headers: ANON_RATE, body: { state: 'closed', merged_at: '2026-11-06T10:00:00Z' } },
          'MetaMask/core#3': { status: 200, headers: ANON_RATE, body: { state: 'closed', merged_at: null } },
          'MetaMask/core#4': { status: 200, headers: ANON_RATE, body: { state: 'open', merged_at: null } },
          // #5–#21 return an unrecognized state → stays unknown, never guessed.
          ...Object.fromEntries(
            Array.from({ length: 17 }, (_, i) => [
              `MetaMask/core#${i + 5}`,
              { status: 200, headers: ANON_RATE, body: { state: 'weird', merged_at: null } },
            ]),
          ),
        },
      }),
    )
    const out = await collectCycle(deps(rec, { baseline }))
    expect(out.status).toBe('complete')
    expect(out.requestsUsed).toBe(3 + 20) // sweep + 20 bounded checks (cap)
    const checks = out.snapshot?.missingChecks ?? []
    expect(checks.length).toBe(20)
    expect(checks.find((c) => c.number === 2)?.state).toBe('MERGED')
    expect(checks.find((c) => c.number === 3)?.state).toBe('CLOSED')
    expect(checks.find((c) => c.number === 4)?.state).toBe('OPEN')
    expect(checks.filter((c) => c.state === 'unknown').length).toBe(17)
    // #22–#25 exceed the check cap and are deliberately absent — the diff
    // will label them unverified rather than inventing outcomes.
    expect(checks.some((c) => c.number > 21)).toBe(false)
  })

  test('too-young baseline: no checks are performed at all', async () => {
    const baseline: TodaySnapshot = {
      schemaVersion: 1,
      collectedAt: '2026-11-08T06:00:00Z', // 6h before NOW → below min age
      authMode: 'anonymous',
      repos: [],
      complete: true,
      partialReason: null,
      rate: null,
      droppedMalformed: 0,
      missingChecks: [],
      prs: [baselinePr(50)],
    }
    const rec = new FetchRecorder(
      happyAnon({
        core: () => ({ status: 200, headers: ANON_RATE, body: [] }),
        mobile: () => ({ status: 200, headers: ANON_RATE, body: [] }),
        extension: () => ({ status: 200, headers: ANON_RATE, body: [] }),
      }),
    )
    const out = await collectCycle(deps(rec, { baseline }))
    expect(out.status).toBe('complete')
    expect(out.requestsUsed).toBe(3)
    expect(out.snapshot?.missingChecks).toEqual([])
  })

  test('partial sweeps never run checks (no false "left the queue" evidence)', async () => {
    const pageOf = (page: number) => Array.from({ length: 100 }, (_, i) => rawPull({ number: (page - 1) * 100 + i + 1 }))
    const baseline: TodaySnapshot = {
      schemaVersion: 1,
      collectedAt: '2026-11-07T00:00:00Z',
      authMode: 'anonymous',
      repos: [],
      complete: true,
      partialReason: null,
      rate: null,
      droppedMalformed: 0,
      missingChecks: [],
      prs: [baselinePr(60)],
    }
    const rec = new FetchRecorder(happyAnon({ core: (page) => nextPage(pageOf(page)) }))
    const out = await collectCycle(deps(rec, { baseline }))
    expect(out.status).toBe('partial')
    expect(out.snapshot?.missingChecks).toEqual([])
    expect(out.requestsUsed).toBe(10)
  })
})

/* ------------------------------------------------------------------ */
/* Round-3 hardening: drift, honest zero-collected outcomes, checks    */
/* stopped reasons, first-reason-wins.                                 */
/* ------------------------------------------------------------------ */

describe('collectCycle — pagination drift and honest stoppages', () => {
  test('a page boundary that jumps NEWER marks the snapshot drift-partial (never complete)', async () => {
    // Page 1: 100 PRs, created_at descending. Page 2's first PR is NEWER
    // than page 1's last — items shifted between fetches; PRs were skipped.
    const page = (start: number, newest: number): RawPull[] =>
      Array.from({ length: PULLS_PER_PAGE }, (_, i) =>
        rawPull({
          number: start + i,
          created_at: new Date(newest - i * 3600_000).toISOString(),
        }),
      )
    const rec = new FetchRecorder(
      happyAnon({
        core: (p) => (p === 1 ? nextPage(page(1, NOW)) : { status: 200, headers: ANON_RATE, body: page(201, NOW + 5 * 3600_000) }),
        mobile: () => ({ status: 200, headers: ANON_RATE, body: [] }),
        extension: () => ({ status: 200, headers: ANON_RATE, body: [] }),
      }),
    )
    const out = await collectCycle(deps(rec))
    expect(out.status).toBe('partial')
    expect(out.snapshot?.partialReason).toBe('drift')
    expect(out.message).toContain('shifted between pages')
    // Other repos were still swept (drift does not stop the world).
    expect(out.snapshot?.repos.map((r) => r.complete)).toEqual([false, true, true])
  })

  test('zero-collected HTTP failure returns a network-error outcome with NO snapshot', async () => {
    const rec = new FetchRecorder(
      happyAnon({
        core: () => ({ status: 503, headers: ANON_RATE, body: { message: 'Service Unavailable' } }),
      }),
    )
    const out = await collectCycle(deps(rec))
    expect(out.status).toBe('network-error')
    expect(out.snapshot).toBeNull()
    expect(out.message).toContain('HTTP')
  })

  test('zero-collected rate limit returns a rate-limited outcome with NO snapshot', async () => {
    const rec = new FetchRecorder(
      happyAnon({
        core: () => ({ status: 403, headers: { ...ANON_RATE, 'x-ratelimit-remaining': '0', 'retry-after': '120' }, body: {} }),
      }),
    )
    const out = await collectCycle(deps(rec))
    expect(out.status).toBe('rate-limited')
    expect(out.snapshot).toBeNull()
    expect(out.retryAtMs).toBe(NOW + 120_000)
  })

  test('a later hard error keeps the FIRST stop reason (page-cap/repo-missing not hidden)', async () => {
    const rec = new FetchRecorder(
      happyAnon({
        core: () => ({ status: 404, headers: ANON_RATE, body: { message: 'Not Found' } }),
        mobile: () => { throw new Error('network down') },
      }),
    )
    const out = await collectCycle(deps(rec))
    expect(out.status).toBe('partial')
    expect(out.snapshot?.partialReason).toBe('repo-missing')
    expect(out.message).toContain('not found')
    // The hard error still ended the sweep: extension was not collected.
    expect(out.snapshot?.repos.map((r) => r.complete)).toEqual([false, false])
  })

  test('missing-PR checks stopped by a rate limit are recorded, not swallowed', async () => {
    const baseline: TodaySnapshot = {
      schemaVersion: 1,
      collectedAt: new Date(NOW - 30 * 3600_000).toISOString(),
      authMode: 'anonymous',
      repos: [],
      complete: true,
      partialReason: null,
      rate: null,
      droppedMalformed: 0,
      checksStoppedReason: null,
      missingChecks: [],
      prs: [rawPullToPr({ number: 42, requested_teams: [{ slug: ASSETS_TEAM_SLUG }] })],
    }
    const rec = new FetchRecorder(
      happyAnon({
        detail: {
          'MetaMask/core#42': { status: 403, headers: { ...ANON_RATE, 'x-ratelimit-remaining': '0', 'retry-after': '60' }, body: {} },
        },
      }),
    )
    const out = await collectCycle(deps(rec, { baseline }))
    expect(out.status).toBe('complete') // the sweep itself was complete
    expect(out.snapshot?.checksStoppedReason).toBe('rate-limit')
    expect(out.snapshot?.missingChecks).toEqual([
      { repo: 'MetaMask/core', number: 42, state: 'unknown' },
    ])
  })
})

function rawPullToPr(overrides: Partial<RawPull> = {}): TodayPr {
  const repo = 'MetaMask/core'
  const raw = rawPull({ ...overrides, html_url: `https://github.com/${repo}/pull/${overrides.number ?? 1}` })
  const pr = require('../../../src/today/normalize').normalizePull(repo, raw)
  if (pr === null) throw new Error('fixture PR failed to normalize')
  return pr
}
