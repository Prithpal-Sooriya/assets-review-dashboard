/**
 * Memory-only personal access token store.
 *
 * Security contract (tested in tests/ui/today/token.test.ts and the e2e
 * token-flow spec):
 *  - The token lives in a module-scoped variable ONLY. It is never written
 *    to localStorage, sessionStorage, IndexedDB, cookies, the URL, or logs.
 *  - It is sent exclusively as an Authorization header to
 *    https://api.github.com (see github.ts — single allow-listed origin).
 *  - It is cleared on reload (module state dies with the page).
 *  - Every auth change bumps an epoch so in-flight results collected under
 *    the previous auth can never be published as current.
 *  - Error text is scrubbed through scrubToken before display/serialization.
 */

let memoryToken: string | null = null
let authEpoch = 0

export function getToken(): string | null {
  return memoryToken
}

export function hasToken(): boolean {
  return memoryToken !== null
}

/** Bumps the epoch. Callers must treat prior in-flight results as stale. */
export function setToken(token: string): number {
  const trimmed = token.trim()
  if (trimmed.length === 0) return clearToken()
  memoryToken = trimmed
  authEpoch += 1
  return authEpoch
}

/** Bumps the epoch. In-flight authenticated requests become unpublishable. */
export function clearToken(): number {
  memoryToken = null
  authEpoch += 1
  return authEpoch
}

export function currentEpoch(): number {
  return authEpoch
}

/**
 * Replace any occurrence of the live token in text with "[redacted]".
 * Applied to every error message and serialized diagnostic before it is
 * rendered, stored, or logged. With no token set it is a no-op.
 */
export function scrubToken(text: string): string {
  if (memoryToken === null || memoryToken.length === 0) return text
  // split/join (not replaceAll with special chars) avoids regex escaping bugs.
  return text.split(memoryToken).join('[redacted]')
}

/**
 * Scrub anything that looks like a GitHub token prefix even when no token is
 * loaded in this module (defence in depth for fixtures, traces, echoes).
 * Matches classic (ghp_/gho_/ghu_/ghs_/ghr_) and fine-grained (github_pat_)
 * token shapes.
 */
export function scrubTokenShapes(text: string): string {
  return text.replace(/\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, '[redacted]')
}

/** Compose both scrubs — use this wherever text leaves the collector. */
export function scrubSecrets(text: string): string {
  return scrubTokenShapes(scrubToken(text))
}
