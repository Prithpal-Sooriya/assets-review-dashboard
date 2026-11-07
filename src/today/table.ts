/**
 * Pure table logic for the Today views: filtering, sorting, grouping.
 * No React, no DOM — fully unit-tested. The URL state drives everything.
 */

import {
  assetsAuthored,
  authorshipOf,
  awaitingInfoOf,
  needsAssetsReview,
  prAgeDays,
} from './classify'
import { KNOWN_REPO_ORDER } from '../data/format'
import { prId, type TodayPr } from './normalize'
import type { AuthorFilter, TodayGroup, TodaySort, TodayView } from './urlstate'

export interface Row {
  pr: TodayPr
  ageDays: number
  /** Group caption this row belongs to (after grouping). */
  groupKey: string
}

export interface GroupedRows {
  groupKey: string
  rows: Row[]
}

function compareRepos(a: string, b: string): number {
  const ia = KNOWN_REPO_ORDER[a] ?? Number.MAX_SAFE_INTEGER
  const ib = KNOWN_REPO_ORDER[b] ?? Number.MAX_SAFE_INTEGER
  if (ia !== ib) return ia - ib
  return a.localeCompare(b)
}

function compareAge(a: Row, b: Row): number {
  if (a.ageDays !== b.ageDays) return b.ageDays - a.ageDays // older first
  return a.pr.number - b.pr.number
}

function compareNewest(a: Row, b: Row): number {
  if (a.ageDays !== b.ageDays) return a.ageDays - b.ageDays
  return a.pr.number - b.pr.number
}

function compareAuthor(a: Row, b: Row): number {
  const byAuthor = a.pr.author.localeCompare(b.pr.author)
  return byAuthor !== 0 ? byAuthor : compareAge(a, b)
}

function compareRepo(a: Row, b: Row): number {
  const byRepo = compareRepos(a.pr.repo, b.pr.repo)
  return byRepo !== 0 ? byRepo : compareAge(a, b)
}

function groupKeyOf(pr: TodayPr, group: TodayGroup): string {
  if (group === 'repo') return pr.repo
  if (group === 'team') {
    const teams = pr.requestedTeams
    return teams.length > 0 ? teams.slice().sort().join(', ') : 'No team request'
  }
  return 'All'
}

export interface TableQuery {
  view: TodayView
  repo: string | null
  author: AuthorFilter
  group: TodayGroup
  sort: TodaySort
}

/** Filter + sort the snapshot's PRs into grouped rows for one view. */
export function buildRows(
  prs: TodayPr[],
  query: TableQuery,
  nowMs: number,
): GroupedRows[] {
  const inView = prs.filter((pr) => (query.view === 'needs' ? needsAssetsReview(pr) : assetsAuthored(pr)))
  const filtered = inView.filter((pr) => {
    if (query.repo !== null && pr.repo !== query.repo) return false
    if (query.view === 'needs') {
      if (query.author === 'internal' && authorshipOf(pr) !== 'internal') return false
      if (query.author === 'external' && authorshipOf(pr) !== 'external') return false
    }
    return true
  })

  const rows: Row[] = filtered.map((pr) => ({
    pr,
    ageDays: prAgeDays(pr, nowMs),
    groupKey: groupKeyOf(pr, query.group),
  }))

  const cmp =
    query.sort === 'newest'
      ? compareNewest
      : query.sort === 'repo'
        ? compareRepo
        : query.sort === 'author'
          ? compareAuthor
          : compareAge // 'oldest' default

  rows.sort(cmp)

  if (query.group === 'none') {
    return [{ groupKey: 'All', rows }]
  }
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const bucket = groups.get(row.groupKey)
    if (bucket !== undefined) bucket.push(row)
    else groups.set(row.groupKey, [row])
  }
  return [...groups.entries()]
    .sort((a, b) => {
      // Repositories in canonical order; team groups alphabetically.
      if (query.group === 'repo') return compareRepos(a[0], b[0])
      return a[0].localeCompare(b[0])
    })
    .map(([groupKey, groupRows]) => ({ groupKey, rows: groupRows }))
}

/** View counts for the tab labels (before repo/author filtering). */
export function viewCounts(
  prs: TodayPr[],
): { needs: number; awaiting: number } {
  let needs = 0
  let awaiting = 0
  for (const pr of prs) {
    if (needsAssetsReview(pr)) needs += 1
    if (assetsAuthored(pr)) awaiting += 1
  }
  return { needs, awaiting }
}

