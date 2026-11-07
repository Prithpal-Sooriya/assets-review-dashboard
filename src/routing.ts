/**
 * Top-level page routing for the dashboard.
 *
 * Two pages, two real URLs (shareable, work on direct load and reload):
 *   Daily      → /            (the default landing page)
 *   Historical → /historical
 *
 * Hash routes:
 *   #/today?…  → Daily. This is the LIVE share-link format for Daily: filter
 *                changes still write the filter state into the hash query
 *                (see src/today/urlstate.ts), so "#/today?repo=…" URLs are
 *                produced by the app today — not just old bookmarks. Treat
 *                them as a current feature; removing them would break every
 *                share link the app emits.
 *   #/history  → Historical. A read-only legacy alias from the hash-routed
 *                era; kept so old bookmarks work on any path.
 * A route-shaped hash wins over the path (the hash is what the user — or a
 * shared link — explicitly asked for); a non-route hash (a plain fragment
 * anchor like "#main") defers to the path and never flips the page.
 *
 * No router dependency: resolution is a pure function and the nav links are
 * plain anchors (real hrefs, full document loads). The host serves the SPA
 * shell for /historical (vercel.json rewrites — kept in sync with pageHref
 * by a unit test; Vite preview does this by default), so direct loads,
 * reloads and back/forward all work.
 */

export type Page = 'daily' | 'historical'

const DAILY_HASH = '/today' // the live share-link format for Daily (filters in the query)
const HISTORICAL_HASH = '/history' // legacy alias kept for old bookmarks
const HISTORICAL_PATH = '/historical'

/** Path-only part of a hash: "#/today?repo=X" → "/today". */
function hashPath(hash: string): string {
  return hash.replace(/^#/, '').split('?')[0] ?? ''
}

/**
 * Normalize a pathname for comparison: strip trailing slashes (never from a
 * bare "/") and treat /index.html as the root.
 */
function normalizePath(pathname: string): string {
  let p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (p === '/index.html') p = '/'
  return p
}

/** Resolve the active page from a location. Pure — unit tested. */
export function resolvePage(pathname: string, hash: string): Page {
  const h = hashPath(hash)
  if (h === DAILY_HASH) return 'daily'
  if (h === HISTORICAL_HASH) return 'historical'
  return normalizePath(pathname) === HISTORICAL_PATH ? 'historical' : 'daily'
}

/**
 * True when a hash names a page route ("#/today", "#/history?…") rather than
 * a plain fragment anchor ("#main"). App re-resolves the page on same-document
 * URL changes only for route-shaped hashes — following an in-page anchor must
 * never flip the page (e.g. Historical held by "#/history" would otherwise
 * flip to Daily on "#main", because the path is "/").
 */
export function isRouteHash(hash: string): boolean {
  const h = hashPath(hash)
  return h === DAILY_HASH || h === HISTORICAL_HASH
}

export interface UrlLocation {
  pathname: string
  hash: string
}

/**
 * Whether App should re-resolve the page after a same-document URL change.
 * Browsers fire popstate for EVERY same-document URL change — hash edits and
 * in-page anchors included, not just back/forward — so the raw event cannot
 * be trusted. Re-resolve only on an explicit page navigation:
 *   - the new hash names a page route ("#/today", "#/history"), or
 *   - the path changed (/ ↔ /historical), or
 *   - a previously-present hash disappeared (back/forward returning to a
 *     hashless URL — following an in-page anchor can never remove the hash,
 *     so a removal always means a history traversal or a manual URL edit,
 *     both of which should honor the path again).
 * A plain fragment anchor ("#main") matches none of these, so following one
 * never flips the page. Pure — unit tested; the e2e suite covers the wiring.
 */
export function shouldResyncOnUrlChange(prev: UrlLocation, next: UrlLocation): boolean {
  return (
    isRouteHash(next.hash) ||
    next.pathname !== prev.pathname ||
    (next.hash === '' && prev.hash !== '')
  )
}

/** Canonical href for a page — what the nav links point at. */
export function pageHref(page: Page): string {
  return page === 'historical' ? HISTORICAL_PATH : '/'
}
