/**
 * Shareable URL state for the Today (Daily) view.
 *
 * Today filters, grouping and sort live in the "#/today?…" hash query string
 * so a filtered view can be shared as a plain URL. The hash path below is
 * FROZEN: it is the live share-link format the app emits, and share links
 * exist in the wild — never rename or drop it. Page-level routing (which
 * honors "#/today" / "#/history" on any path) lives in src/routing.ts and
 * imports TODAY_HASH_PATH from here so the format has a single source.
 * Unknown or malformed parameters fall back to defaults rather than being
 * invented or crashing.
 */

import { TODAY_REPOS } from './config'

/** Frozen hash path of the Daily share-link format ("#/today?…"). */
export const TODAY_HASH_PATH = '/today'

export type TodayView = 'needs' | 'awaiting'
export type TodaySort = 'oldest' | 'newest' | 'repo' | 'author'
export type TodayGroup = 'repo' | 'team' | 'none'
export type AuthorFilter = 'all' | 'internal' | 'external'

export interface TodayUrlState {
  view: TodayView
  repo: string | null
  author: AuthorFilter
  group: TodayGroup
  sort: TodaySort
}

export const DEFAULT_TODAY_STATE: TodayUrlState = {
  // Team PRs land first: the team's own open non-draft PRs (including
  // internal review needs) are the default landing; the review-requests
  // view is one click away with its count on the button. The 'needs' /
  // 'awaiting' URL values are frozen (share links exist in the wild) — only
  // which one is the default changed. The names are historical (they date
  // from the old view names 'Needs Assets review' / 'Assets PRs awaiting
  // others') and leak into counts.needs/awaiting, diff.needs/awaiting,
  // needsAssetsReview and assetsAuthored — deliberate: renaming any of them
  // would break the frozen URL format or churn every call site for zero
  // behavioral gain.
  view: 'awaiting',
  repo: null,
  author: 'all',
  group: 'repo',
  sort: 'oldest',
}

const VIEW_VALUES: readonly TodayView[] = ['needs', 'awaiting']
const SORT_VALUES: readonly TodaySort[] = ['oldest', 'newest', 'repo', 'author']
const GROUP_VALUES: readonly TodayGroup[] = ['repo', 'team', 'none']
const AUTHOR_VALUES: readonly AuthorFilter[] = ['all', 'internal', 'external']

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/** Parse a location hash like "#/today?repo=MetaMask%2Fcore&sort=newest". */
export function parseHash(hash: string): TodayUrlState {
  const clean = hash.replace(/^#/, '')
  const [, query] = clean.split('?')

  const params = new URLSearchParams(query ?? '')
  const repo = params.get('repo')
  return {
    view: oneOf(params.get('view'), VIEW_VALUES, DEFAULT_TODAY_STATE.view),
    // Same single source as the collector's sweep: config's TODAY_REPOS.
    repo: repo !== null && TODAY_REPOS.includes(repo) ? repo : null,
    author: oneOf(params.get('author'), AUTHOR_VALUES, DEFAULT_TODAY_STATE.author),
    group: oneOf(params.get('group'), GROUP_VALUES, DEFAULT_TODAY_STATE.group),
    sort: oneOf(params.get('sort'), SORT_VALUES, DEFAULT_TODAY_STATE.sort),
  }
}

/** Serialize Today state back into a hash string (round-trips parseHash). */
export function buildTodayHash(state: TodayUrlState): string {
  const params = new URLSearchParams()
  // `view` is ALWAYS written explicitly — never elided even when equal to
  // the default — so every share link ever produced by any build pins its
  // view. Changing DEFAULT_TODAY_STATE.view therefore cannot retarget old
  // shared links: `?view=needs` keeps opening Review requests forever.
  params.set('view', state.view)
  if (state.repo !== null) params.set('repo', state.repo)
  if (state.author !== 'all') params.set('author', state.author)
  if (state.group !== DEFAULT_TODAY_STATE.group) params.set('group', state.group)
  if (state.sort !== DEFAULT_TODAY_STATE.sort) params.set('sort', state.sort)
  return `#${TODAY_HASH_PATH}?${params.toString()}`
}

/**
 * Replace the current hash without spamming history entries (filters are
 * state, not navigation). Called on every filter change so the URL is always
 * shareable.
 */
export function applyHash(hash: string): void {
  if (typeof window === 'undefined' || typeof window.history === 'undefined') return
  const target = `#${hash.replace(/^#/, '')}`
  if (window.location.hash === target) return
  window.history.replaceState(null, '', target)
}
