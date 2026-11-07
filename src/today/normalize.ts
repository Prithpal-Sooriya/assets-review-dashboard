/**
 * Normalize raw GitHub REST pull entries into the cached TodayPr shape.
 *
 * Only public fields of the configured public repositories are retained:
 * identity, title, author login, draft flag, timestamps, label names,
 * requested team slugs and requested reviewer logins. No request headers,
 * no token, no account data, no comment/diff content — ever.
 */

import type { RawPull } from './github'

export const TODAY_SCHEMA_VERSION = 1

export interface TodayPr {
  repo: string
  number: number
  title: string
  url: string
  author: string
  draft: boolean
  createdAt: string
  updatedAt: string
  labels: string[]
  requestedTeams: string[]
  requestedReviewers: string[]
}

export interface RepoSweepInfo {
  repo: string
  pagesFetched: number
  /** True when all open PRs were fetched (no page cap / budget stoppage). */
  complete: boolean
}

export type AuthMode = 'anonymous' | 'token'

export type PartialReason =
  | 'page-cap'
  | 'budget'
  | 'rate-limit'
  | 'aborted'
  | 'network'
  | 'repo-missing'

export interface MissingPrCheck {
  repo: string
  number: number
  state: 'MERGED' | 'CLOSED' | 'OPEN' | 'unknown'
}

export interface TodaySnapshot {
  schemaVersion: number
  collectedAt: string
  authMode: AuthMode
  repos: RepoSweepInfo[]
  /** True only when every repo paginated fully within budget. */
  complete: boolean
  partialReason: PartialReason | null
  rate: { limit: number | null; remaining: number | null; reset: string | null } | null
  prs: TodayPr[]
  /** Entries dropped for malformed fields (counted, never silently hidden). */
  droppedMalformed: number
  /** Bounded missing-PR state checks (since-yesterday diff evidence). */
  missingChecks: MissingPrCheck[]
}

const MAX_LABELS = 10
const MAX_LIST = 25

function cleanString(value: unknown, maxLen = 300): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLen) return null
  // Strip control characters that could poison rendering or storage.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  return trimmed
}

function cleanSlugList(items: { slug: unknown }[] | null, max: number): string[] {
  if (!Array.isArray(items)) return []
  const out: string[] = []
  for (const item of items) {
    const slug = cleanString(item?.slug, 100)
    if (slug !== null && !out.includes(slug)) out.push(slug)
    if (out.length >= max) break
  }
  return out
}

function cleanLoginList(items: { login: unknown }[] | null, max: number): string[] {
  if (!Array.isArray(items)) return []
  const out: string[] = []
  for (const item of items) {
    const login = cleanString(item?.login, 100)
    if (login !== null && !out.includes(login)) out.push(login)
    if (out.length >= max) break
  }
  return out
}

/**
 * PR links are rendered as anchors, so the URL must be a genuine GitHub
 * pull-request URL — anything else (javascript:, other hosts) is rejected.
 */
function cleanPullUrl(value: unknown): string | null {
  const raw = cleanString(value, 300)
  if (raw === null) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null
  if (!/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(parsed.pathname)) return null
  return raw
}

/**
 * Normalize one raw pull. Returns null for entries whose identity fields are
 * malformed — such entries are counted as droppedMalformed, never rendered.
 */
export function normalizePull(repo: string, raw: RawPull): TodayPr | null {
  if (typeof raw?.number !== 'number' || !Number.isInteger(raw.number) || raw.number < 1) {
    return null
  }
  const title = cleanString(raw.title, 300)
  const url = cleanPullUrl(raw.html_url)
  // A missing/garbled author (e.g. deleted account) degrades to 'unknown'
  // rather than dropping the PR — the request itself is still real.
  const author = cleanString(raw.user?.login, 100) ?? 'unknown'
  const createdAt = cleanString(raw.created_at, 40)
  const updatedAt = cleanString(raw.updated_at, 40)
  if (title === null || url === null || author === null || createdAt === null || updatedAt === null) {
    return null
  }
  // Dates must be parseable; garbage timestamps poison age math and diffs.
  if (Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt))) return null
  const labels = Array.isArray(raw.labels)
    ? raw.labels
        .map((l) => cleanString(l?.name, 100))
        .filter((n): n is string => n !== null)
        .slice(0, MAX_LABELS)
    : []
  return {
    repo,
    number: raw.number,
    title,
    url,
    author,
    draft: raw.draft === true,
    createdAt,
    updatedAt,
    labels,
    requestedTeams: cleanSlugList(raw.requested_teams, MAX_LIST),
    requestedReviewers: cleanLoginList(raw.requested_reviewers, MAX_LIST),
  }
}

export function prId(pr: TodayPr): string {
  return `${pr.repo}#${pr.number}`
}

/** Defensive revalidation of a record read back from IndexedDB. */
export function isTodaySnapshot(value: unknown): value is TodaySnapshot {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<TodaySnapshot>
  if (v.schemaVersion !== TODAY_SCHEMA_VERSION) return false
  if (typeof v.collectedAt !== 'string') return false
  if (v.authMode !== 'anonymous' && v.authMode !== 'token') return false
  if (!Array.isArray(v.repos) || !Array.isArray(v.prs) || !Array.isArray(v.missingChecks)) {
    return false
  }
  if (typeof v.complete !== 'boolean') return false
  if (typeof v.droppedMalformed !== 'number') return false
  return true
}
