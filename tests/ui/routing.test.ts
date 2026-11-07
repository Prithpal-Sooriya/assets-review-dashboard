import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isRouteHash, pageHref, resolvePage, shouldResyncOnUrlChange, type Page, type UrlLocation } from '../../src/routing'

/**
 * Page routing: Daily lives at /, Historical at /historical. Hash routes are
 * honored on any path: #/today?… is the LIVE share-link format for Daily
 * (filter state lives in the hash query and the app emits these URLs today),
 * #/history is a read-only legacy alias for old bookmarks.
 */
describe('resolvePage', () => {
  test('root path (no hash) is Daily — the landing page', () => {
    expect(resolvePage('/', '')).toBe('daily')
  })

  test('/historical is Historical, with and without trailing slash', () => {
    expect(resolvePage('/historical', '')).toBe('historical')
    expect(resolvePage('/historical/', '')).toBe('historical')
  })

  test('/index.html is treated as the root (Daily)', () => {
    expect(resolvePage('/index.html', '')).toBe('daily')
  })

  test('#/today shows Daily on any path (live share-link format), with or without filters', () => {
    expect(resolvePage('/', '#/today')).toBe('daily')
    expect(resolvePage('/historical', '#/today')).toBe('daily')
    expect(resolvePage('/', '#/today?view=awaiting&repo=MetaMask%2Fcore&sort=newest')).toBe('daily')
  })

  test('#/history shows Historical on any path (legacy alias for old bookmarks)', () => {
    expect(resolvePage('/', '#/history')).toBe('historical')
    expect(resolvePage('/historical', '#/history')).toBe('historical')
  })

  test('unknown or empty hashes defer to the path', () => {
    expect(resolvePage('/', '#')).toBe('daily')
    expect(resolvePage('/', '#/')).toBe('daily')
    expect(resolvePage('/', '#/anything-old')).toBe('daily')
    expect(resolvePage('/historical', '#/anything-old')).toBe('historical')
    expect(resolvePage('/historical', '#some-anchor')).toBe('historical')
  })

  test('unknown paths fall back to Daily (single-page shell)', () => {
    expect(resolvePage('/today', '')).toBe('daily')
    expect(resolvePage('/daily', '')).toBe('daily')
  })
})

describe('pageHref', () => {
  test('canonical hrefs: / for Daily, /historical for Historical', () => {
    expect(pageHref('daily')).toBe('/')
    expect(pageHref('historical')).toBe('/historical')
  })
})

describe('isRouteHash', () => {
  test('route-shaped hashes (with or without filter query) are route hashes', () => {
    expect(isRouteHash('#/today')).toBe(true)
    expect(isRouteHash('#/today?view=awaiting&repo=MetaMask%2Fcore')).toBe(true)
    expect(isRouteHash('#/history')).toBe(true)
  })

  test('plain fragment anchors and unknown hashes are not route hashes', () => {
    expect(isRouteHash('#main')).toBe(false)
    expect(isRouteHash('')).toBe(false)
    expect(isRouteHash('#')).toBe(false)
    expect(isRouteHash('#/')).toBe(false)
    expect(isRouteHash('#/anything-old')).toBe(false)
  })
})

describe('shouldResyncOnUrlChange', () => {
  const loc = (pathname: string, hash = ''): UrlLocation => ({ pathname, hash })

  test('route-shaped hash changes re-resolve (explicit page navigation)', () => {
    expect(shouldResyncOnUrlChange(loc('/'), loc('/', '#/today'))).toBe(true)
    expect(shouldResyncOnUrlChange(loc('/'), loc('/', '#/history'))).toBe(true)
    expect(shouldResyncOnUrlChange(loc('/historical'), loc('/historical', '#/today?repo=MetaMask%2Fcore'))).toBe(true)
  })

  test('plain fragment anchors never re-resolve on the same path', () => {
    // Historical held by the #/history hash at / must survive an anchor hop.
    expect(shouldResyncOnUrlChange(loc('/', '#/history'), loc('/', '#main'))).toBe(false)
    expect(shouldResyncOnUrlChange(loc('/'), loc('/', '#main'))).toBe(false)
    expect(shouldResyncOnUrlChange(loc('/historical', '#/today'), loc('/historical', '#main'))).toBe(false)
  })

  test('path changes re-resolve (back/forward between / and /historical)', () => {
    expect(shouldResyncOnUrlChange(loc('/'), loc('/historical'))).toBe(true)
    expect(shouldResyncOnUrlChange(loc('/historical'), loc('/'))).toBe(true)
  })

  test('a disappearing hash re-resolves — back to a hashless URL', () => {
    // Adverse round-2 repro: /historical (Historical) → #/today (Daily) →
    // Back → hashless /historical must restore Historical. An in-page anchor
    // can never REMOVE the hash, so a removal is always a traversal/manual
    // edit and should honor the path again.
    expect(shouldResyncOnUrlChange(loc('/historical', '#/today'), loc('/historical', ''))).toBe(true)
    expect(shouldResyncOnUrlChange(loc('/', '#main'), loc('/'))).toBe(true)
    expect(shouldResyncOnUrlChange(loc('/'), loc('/'))).toBe(false)
  })
})

describe('vercel.json rewrites stay in sync with routing (drift guard)', () => {
  // The e2e suite runs against Vite preview, which serves the SPA shell for
  // ANY path — so a broken/missing production rewrite cannot fail e2e. This
  // test is the only automated check tying vercel.json to routing.ts.
  test('every non-root pageHref (and its trailing-slash variant) has a rewrite', () => {
    const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')) as {
      rewrites?: { source: string; destination: string }[]
    }
    const sources = new Set((vercel.rewrites ?? []).map((r) => r.source))
    for (const page of ['daily', 'historical'] as const satisfies readonly Page[]) {
      const href = pageHref(page)
      if (href === '/') continue // the static host serves the root shell itself
      expect(sources.has(href), `rewrite for ${href}`).toBe(true)
      expect(sources.has(`${href}/`), `rewrite for ${href}/ (trailing slash)`).toBe(true)
    }
  })
})
