import { describe, expect, test } from 'bun:test'
import { githubGet, linkHasNext, GitHubError, rateLimitUrl } from '../../../src/today/github'

describe('linkHasNext', () => {
  test('detects rel="next" in either quote style', () => {
    expect(linkHasNext('<https://x?page=2>; rel="next", <https://x?page=9>; rel="last"')).toBe(true)
    expect(linkHasNext("<https://x?page=2>; rel='next'")).toBe(true)
  })

  test('null or last-only headers mean no next page', () => {
    expect(linkHasNext(null)).toBe(false)
    expect(linkHasNext('<https://x?page=9>; rel="last"')).toBe(false)
  })
})

describe('githubGet — every error class is classified by contract', () => {
  const NOW = 1_000_000
  const respond = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    async (): Promise<Response> =>
      new Response(JSON.stringify(body), { status, headers })

  const get = async (fetchImpl: () => Promise<Response>, url = rateLimitUrl()) => {
    try {
      const res = await githubGet(url, { fetchImpl, token: 'ghp_testtoken', nowMs: NOW })
      return { ok: true as const, res }
    } catch (err) {
      return { ok: false as const, err: err as GitHubError }
    }
  }

  test('the origin allow-list blocks any non-api.github.com URL', async () => {
    const out = await get(respond(200), 'https://evil.example.com/rate_limit')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected failure')
    expect(out.err.kind).toBe('http')
    expect(out.err.message).toBe('Blocked non-API request')
  })

  test('401 is auth-rejected (token never echoed)', async () => {
    const out = await get(respond(401, { message: 'Bad credentials' }))
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected failure')
    expect(out.err.kind).toBe('auth-rejected')
    expect(out.err.message).not.toContain('ghp_')
  })

  test('429 with Retry-After is rate-limited with retry guidance', async () => {
    const out = await get(respond(429, {}, { 'retry-after': '30' }))
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected failure')
    expect(out.err.kind).toBe('rate-limited')
    expect(out.err.retryAtMs).toBe(NOW + 30_000)
  })

  test('403 with exhausted quota is rate-limited; plain 403 (SSO/abuse) is http', async () => {
    const limited = await get(respond(403, {}, { 'x-ratelimit-remaining': '0' }))
    expect(limited.ok).toBe(false)
    if (limited.ok) throw new Error('expected failure')
    expect(limited.err.kind).toBe('rate-limited')
    const forbidden = await get(respond(403))
    expect(forbidden.ok).toBe(false)
    if (forbidden.ok) throw new Error('expected failure')
    expect(forbidden.err.kind).toBe('http')
    expect(forbidden.err.message).toContain('403')
  })

  test('404 is not-found; 304 and 5xx are honest http errors', async () => {
    const notFound = await get(respond(404))
    expect(notFound.ok).toBe(false)
    if (notFound.ok) throw new Error('expected failure')
    expect(notFound.err.kind).toBe('not-found')
    const notModified = await get(respond(304))
    if (notModified.ok) throw new Error('expected failure')
    expect(notModified.err.kind).toBe('http')
    const server = await get(respond(503, {}, { 'retry-after': '1' }))
    if (server.ok) throw new Error('expected failure')
    expect(server.err.kind).toBe('http')
    expect(server.err.message).toContain('503')
  })

  test('invalid JSON is http, never a crash', async () => {
    const bad = async (): Promise<Response> => new Response('not json', { status: 200 })
    const out = await get(bad)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected failure')
    expect(out.err.kind).toBe('http')
  })

  test('network failure (fetch rejection) is network; scrubbed, no internals', async () => {
    const fail = async (): Promise<Response> => {
      throw new TypeError('Failed to fetch https://api.github.com/ with ghp_secret')
    }
    const out = await get(fail)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected failure')
    expect(out.err.kind).toBe('network')
    expect(out.err.message).not.toContain('ghp_')
    expect(out.err.message).not.toContain('https')
  })

  test('abort AFTER rejection is classified aborted (unmount wins)', async () => {
    const controller = new AbortController()
    const fail = async (): Promise<Response> => {
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    }
    const out = await githubGet(rateLimitUrl(), {
      fetchImpl: fail,
      token: null,
      signal: controller.signal,
      nowMs: NOW,
    }).then(
      () => null,
      (err: GitHubError) => err,
    )
    expect(out?.kind).toBe('aborted')
  })

  test('200 returns data, rate headers and Link pagination', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'x-ratelimit-limit': '60',
          'x-ratelimit-remaining': '59',
          'x-ratelimit-reset': '1799070000',
          link: '<https://api.github.com/repos/x/y/pulls?page=2>; rel="next"',
        },
      })
    const out = await get(fetchImpl)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.res.data).toEqual({ ok: true })
      expect(out.res.rate).toEqual({ limit: 60, remaining: 59, reset: 1799070000 })
      expect(out.res.linkNext).toBe(true)
    }
  })
})
