/**
 * Hash-based routing + shareable URL state for the Today view.
 *
 * Routes: "#/today" (Today) and "#/history" or no hash (History — the
 * original behavior and any existing links are preserved). Today filters,
 * grouping and sort live in the hash query string so a filtered view can be
 * shared as a plain URL. Unknown or malformed parameters fall back to
 * defaults rather than being invented or crashing.
 */

import { TODAY_REPOS } from './config'

export type Route = 'today' | 'history'

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
  view: 'needs',
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
export function parseHash(hash: string): { route: Route; today: TodayUrlState } {
  const clean = hash.replace(/^#/, '')
  const [path, query] = clean.split('?')
  const route: Route = path === '/today' ? 'today' : 'history'

  const params = new URLSearchParams(query ?? '')
  const repo = params.get('repo')
  return {
    route,
    today: {
      view: oneOf(params.get('view'), VIEW_VALUES, DEFAULT_TODAY_STATE.view),
      // Same single source as the collector's sweep: config's TODAY_REPOS.
      repo: repo !== null && TODAY_REPOS.includes(repo) ? repo : null,
      author: oneOf(params.get('author'), AUTHOR_VALUES, DEFAULT_TODAY_STATE.author),
      group: oneOf(params.get('group'), GROUP_VALUES, DEFAULT_TODAY_STATE.group),
      sort: oneOf(params.get('sort'), SORT_VALUES, DEFAULT_TODAY_STATE.sort),
    },
  }
}

/** Serialize Today state back into a hash string (round-trips parseHash). */
export function buildTodayHash(state: TodayUrlState): string {
  const params = new URLSearchParams()
  params.set('view', state.view)
  if (state.repo !== null) params.set('repo', state.repo)
  if (state.author !== 'all') params.set('author', state.author)
  if (state.group !== DEFAULT_TODAY_STATE.group) params.set('group', state.group)
  if (state.sort !== DEFAULT_TODAY_STATE.sort) params.set('sort', state.sort)
  return `#/today?${params.toString()}`
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
