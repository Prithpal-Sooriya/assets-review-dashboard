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
  | 'http'
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

const CHECK_STATES: ReadonlySet<string> = new Set(['MERGED', 'CLOSED', 'OPEN', 'unknown'])
// Derived from the PartialReason union: the Record<> shape makes TypeScript
// fail to compile if a member is missing, so the sanitizer can never reject
// (or silently relabel) a reason the collector actually emits.
const PARTIAL_REASON_TABLE: Record<PartialReason, true> = {
  'page-cap': true,
  budget: true,
  'rate-limit': true,
  aborted: true,
  network: true,
  http: true,
  'repo-missing': true,
}
const PARTIAL_REASONS: ReadonlySet<string> = new Set(Object.keys(PARTIAL_REASON_TABLE))

function sanitizePr(value: unknown): TodayPr | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Partial<TodayPr>
  if (typeof v.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.repo)) return null
  if (typeof v.number !== 'number' || !Number.isInteger(v.number) || v.number < 1) return null
  // Single field-rule source: re-run the same normalizePull rules the
  // collector used, on a raw-shaped view of the cached record, so the two
  // validation paths can never drift apart.
  const asString = (x: unknown): string | null => (typeof x === 'string' ? x : null)
  return normalizePull(v.repo, {
    number: v.number,
    title: asString(v.title),
    html_url: asString(v.url),
    draft: v.draft === true,
    created_at: asString(v.createdAt),
    updated_at: asString(v.updatedAt),
    user: { login: asString(v.author) },
    labels: Array.isArray(v.labels) ? v.labels.map((name) => ({ name })) : null,
    requested_reviewers: Array.isArray(v.requestedReviewers)
      ? v.requestedReviewers.map((login) => ({ login }))
      : null,
    requested_teams: Array.isArray(v.requestedTeams)
      ? v.requestedTeams.map((slug) => ({ slug }))
      : null,
  })
}

function sanitizeMissingCheck(value: unknown): MissingPrCheck | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Partial<MissingPrCheck>
  if (typeof v.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.repo)) return null
  if (typeof v.number !== 'number' || !Number.isInteger(v.number) || v.number < 1) return null
  if (typeof v.state !== 'string' || !CHECK_STATES.has(v.state)) return null
  return { repo: v.repo, number: v.number, state: v.state as MissingPrCheck['state'] }
}

/**
 * Revalidate an UNTRUSTED snapshot (IndexedDB record or cross-tab broadcast)
 * end-to-end: top-level shape plus every PR's URL, dates and identity fields.
 * Malformed PRs/checks are dropped (counted into droppedMalformed), so a
 * planted javascript:/phishing href can never reach an <a href>. Returns null
 * when the record is unusable at the top level.
 */
/** Structural top-level check (single source, used by sanitizeSnapshot). */
function isTodaySnapshotShape(value: unknown): value is TodaySnapshot {
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

export function sanitizeSnapshot(value: unknown): TodaySnapshot | null {
  if (!isTodaySnapshotShape(value)) return null
  const prs: TodayPr[] = []
  let dropped = value.droppedMalformed
  for (const raw of value.prs) {
    const clean = sanitizePr(raw)
    if (clean === null) {
      dropped += 1
      continue
    }
    prs.push(clean)
  }
  const missingChecks = value.missingChecks
    .map(sanitizeMissingCheck)
    .filter((c): c is MissingPrCheck => c !== null)
  const partialReason =
    value.partialReason === null || PARTIAL_REASONS.has(value.partialReason)
      ? (value.partialReason as TodaySnapshot['partialReason'])
      : 'aborted'
  return {
    schemaVersion: value.schemaVersion,
    collectedAt: value.collectedAt,
    authMode: value.authMode,
    repos: value.repos,
    complete: value.complete,
    partialReason,
    rate: value.rate,
    droppedMalformed: dropped,
    missingChecks,
    prs,
  }
}

