import { describe, expect, test } from 'bun:test'
import { pageHref, resolvePage } from '../../src/routing'

/**
 * Page routing: Daily lives at /, Historical at /historical, and the legacy
 * hash routes (#/today, #/history) are preserved on any path so old
 * bookmarks and shared filter links keep working.
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

  test('legacy #/today shows Daily on any path, with or without filters', () => {
    expect(resolvePage('/', '#/today')).toBe('daily')
    expect(resolvePage('/historical', '#/today')).toBe('daily')
    expect(resolvePage('/', '#/today?view=awaiting&repo=MetaMask%2Fcore&sort=newest')).toBe('daily')
  })

  test('legacy #/history shows Historical on any path (old bookmarks)', () => {
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
