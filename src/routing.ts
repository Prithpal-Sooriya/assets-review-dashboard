/**
 * Top-level page routing for the dashboard.
 *
 * Two pages, two real URLs (shareable, work on direct load and reload):
 *   Daily      → /            (the default landing page)
 *   Historical → /historical
 *
 * Legacy compatibility — the app originally shipped with hash-only routes,
 * and Daily filter links still live in the hash (shareable filtered views):
 *   #/today?…  → Daily (the query string carries the shared filter state)
 *   #/history  → Historical
 * An explicit legacy hash wins over the path so old bookmarks and shared
 * filter links keep working on any path they are pasted onto; an unknown or
 * absent hash defers to the path.
 *
 * No router dependency: resolution is a pure function and the nav links are
 * plain anchors (real hrefs, full document loads). The host serves the SPA
 * shell for /historical (vercel.json rewrite; Vite preview does this by
 * default), so direct loads, reloads and back/forward all work.
 */

export type Page = 'daily' | 'historical'

const LEGACY_DAILY_HASH = '/today'
const LEGACY_HISTORICAL_HASH = '/history'
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
  if (h === LEGACY_DAILY_HASH) return 'daily'
  if (h === LEGACY_HISTORICAL_HASH) return 'historical'
  return normalizePath(pathname) === HISTORICAL_PATH ? 'historical' : 'daily'
}

/** Canonical href for a page — what the nav links point at. */
export function pageHref(page: Page): string {
  return page === 'historical' ? HISTORICAL_PATH : '/'
}
