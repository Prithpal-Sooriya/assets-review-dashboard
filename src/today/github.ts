/**
 * Minimal GitHub REST client for the Today view.
 *
 * Security properties (regression-tested):
 *  - Only GITHUB_API_ORIGIN (https://api.github.com) is ever contacted; URLs
 *    are constructed from configured repo slugs and integers — never from
 *    response bodies or arbitrary strings.
 *  - `redirect: 'error'` means a redirect FAILS the request, so the
 *    Authorization header can never be forwarded to any other origin.
 *  - Error messages carry the HTTP status only — response bodies are never
 *    echoed — and are scrubbed of token shapes before leaving this module.
 *  - Pagination walks explicit integer page numbers (no Link-URL following);
 *    the Link header is only read to detect whether a next page exists.
 */

import { GITHUB_API_ORIGIN, PULLS_PER_PAGE } from './config'
import { isPossiblyRateLimitedStatus, parseRateHeaders, rateRetryAtMs, type RateInfo } from './ratelimit'
import { scrubSecrets } from './token'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'network'
      | 'rate-limited'
      | 'auth-rejected'
      | 'not-found'
      | 'http'
      | 'aborted',
    readonly retryAtMs: number | null = null,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

export interface ApiResponse<T> {
  data: T
  rate: RateInfo
  linkNext: boolean
}

/** Build the (only) class of URLs this module may fetch. */
export function pullsListUrl(repo: string, page: number): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('Invalid repository slug')
  }
  if (!Number.isInteger(page) || page < 1 || page > 100) {
    throw new Error('Invalid page number')
  }
  return (
    `${GITHUB_API_ORIGIN}/repos/${repo}/pulls` +
    `?state=open&sort=created&direction=desc&per_page=${PULLS_PER_PAGE}&page=${page}`
  )
}

export function pullDetailUrl(repo: string, number_: number): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('Invalid repository slug')
  }
  if (!Number.isInteger(number_) || number_ < 1 || number_ > 100_000_000) {
    throw new Error('Invalid pull number')
  }
  return `${GITHUB_API_ORIGIN}/repos/${repo}/pulls/${number_}`
}

export function rateLimitUrl(): string {
  return `${GITHUB_API_ORIGIN}/rate_limit`
}

/** All outbound requests funnel through here. */
export async function githubGet<T>(
  url: string,
  opts: { fetchImpl: FetchLike; token: string | null; signal?: AbortSignal; nowMs: number },
): Promise<ApiResponse<T>> {
  if (!url.startsWith(`${GITHUB_API_ORIGIN}/`)) {
    // Allow-list: construction already guarantees this; assert as a guard so
    // any future regression fails closed instead of leaking requests.
    throw new GitHubError('Blocked non-API request', 'http')
  }
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token}`

  let response: Response
  try {
    response = await opts.fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'error', // never forward auth off api.github.com
      signal: opts.signal,
    })
  } catch (err) {
    if (opts.signal?.aborted) throw new GitHubError('Request aborted', 'aborted')
    // Network/redirect/CORS failure: never echo internals, scrub token shapes.
    throw new GitHubError(scrubSecrets(`Request failed: ${err instanceof Error ? err.name : 'unknown'}`), 'network')
  }

  if (response.status === 401) {
    throw new GitHubError('Token rejected (HTTP 401)', 'auth-rejected')
  }
  if (isPossiblyRateLimitedStatus(response.status)) {
    // Distinguish a true rate limit (remaining 0 / Retry-After) from other
    // 403s (GitHub also uses 403 for SSO/abuse); retry guidance only when
    // rate headers or Retry-After are present.
    const retryAfter = response.headers.get('retry-after')
    const rate = parseRateHeaders(response.headers)
    const limited =
      retryAfter !== null || rate.remaining === 0 || response.status === 429
    if (limited) {
      throw new GitHubError(
        `Rate limited (HTTP ${response.status})`,
        'rate-limited',
        rateRetryAtMs(response.status, response.headers, opts.nowMs) ?? opts.nowMs + 60_000,
      )
    }
    throw new GitHubError(`Forbidden (HTTP 403)`, 'http')
  }
  if (response.status === 404) {
    throw new GitHubError('Not found (HTTP 404)', 'not-found')
  }
  if (response.status === 304) {
    // We send no conditional headers; treat as unexpected but non-fatal.
    throw new GitHubError('Unexpected 304', 'http')
  }
  if (response.status < 200 || response.status >= 300) {
    throw new GitHubError(`HTTP ${response.status}`, 'http')
  }

  let data: T
  try {
    data = (await response.json()) as T
  } catch {
    throw new GitHubError('Response was not valid JSON', 'http')
  }
  return {
    data,
    rate: parseRateHeaders(response.headers),
    linkNext: linkHasNext(response.headers.get('link')),
  }
}

/** Does a Link header advertise a rel="next" page (quotes either style)? */
export function linkHasNext(linkHeader: string | null): boolean {
  if (linkHeader === null) return false
  return /rel="next"/.test(linkHeader) || /rel='next'/.test(linkHeader)
}

/** Raw pull shape — only the public fields we normalize are declared. */
export interface RawPull {
  number: number
  title: unknown
  html_url: unknown
  draft: unknown
  created_at: unknown
  updated_at: unknown
  user: { login: unknown } | null
  labels: { name: unknown }[] | null
  requested_teams: { slug: unknown }[] | null
  requested_reviewers: { login: unknown }[] | null
}

/** Raw pull-detail shape for missing-PR state checks. */
export interface RawPullDetail {
  state: unknown
  merged_at: unknown
}

/** Free pre-flight check (does not count against the core rate limit). */
export async function getCoreRateLimit(opts: {
  fetchImpl: FetchLike
  token: string | null
  signal?: AbortSignal
  nowMs: number
}): Promise<RateInfo> {
  const res = await githubGet<{ resources: { core?: RateInfo } | null }>(
    rateLimitUrl(),
    { ...opts, token: null }, // deliberately anonymous: free endpoint, no auth needed
  )
  const core = res.data?.resources?.core
  if (
    core &&
    typeof core.limit === 'number' &&
    typeof core.remaining === 'number' &&
    typeof core.reset === 'number'
  ) {
    return core
  }
  return { limit: null, remaining: null, reset: null }
}
