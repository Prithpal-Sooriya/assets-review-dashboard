import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/**
 * The production CSP (vercel.json) allows exactly one inline script: the
 * no-flash theme init in index.html, pinned by sha256. This test keeps the
 * hash in sync with the file so production never silently blocks theming.
 */
describe('CSP inline-script hash', () => {
  test("vercel.json pins the sha256 of index.html's theme script", () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
    const vercel = readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')

    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    expect(scripts.length).toBe(1) // only the theme init may be inline

    const content = scripts[0]![1]!
    const hash = createHash('sha256').update(content, 'utf8').digest('base64')
    const expected = `sha256-${hash}`

    const csp = JSON.parse(vercel).headers[0].headers.find(
      (h: { key: string; value: string }) => h.key === 'Content-Security-Policy',
    ).value as string
    expect(csp).toContain(`script-src 'self' '${expected}'`)
  })

  test('CSP forbids object, frames and external connections', () => {
    const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'))
    const csp: string = vercel.headers[0].headers.find(
      (h: { key: string; value: string }) => h.key === 'Content-Security-Policy',
    ).value
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  /**
   * The Today view fetches public data directly from the GitHub REST API in
   * the browser. connect-src is the exact-origin allow-list for that: only
   * 'self' and https://api.github.com — no wildcards, no other hosts, no
   * scheme-relative or subdomain loopholes.
   */
  test('CSP allow-lists exactly self and api.github.com for connections', () => {
    const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf-8'))
    const csp: string = vercel.headers[0].headers.find(
      (h: { key: string; value: string }) => h.key === 'Content-Security-Policy',
    ).value
    const connectSrc = /connect-src ([^;]+)/.exec(csp)?.[1]?.trim()
    expect(connectSrc).toBe("'self' https://api.github.com")
  })
})
