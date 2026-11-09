/**
 * Pure classification for the Today views.
 *
 * Core principle (from the approved spec): an entry appears in "Review
 * requests" ONLY because of an explicit outstanding review request to the
 * configured team or one of its members — authorship, ownership labels and
 * past review participation never prove a request. "Team PRs" is an
 * authorship view (team-authored open PRs) and is reported separately; a PR
 * can legitimately appear in both views. Draft PRs are excluded from BOTH
 * views (rows and counts): the user asked for open, non-draft PRs only.
 */

import { ASSETS_ROSTER, ASSETS_TEAM_SLUG } from './config'
import type { TodayPr } from './normalize'

export const ROSTER_SET: ReadonlySet<string> = new Set(ASSETS_ROSTER)

export type Authorship = 'internal' | 'external'

export function authorshipOf(pr: TodayPr): Authorship {
  return ROSTER_SET.has(pr.author) ? 'internal' : 'external'
}

/** Explicit outstanding request to the Assets team slug? (invisible anonymously) */
export function hasTeamRequest(pr: TodayPr): boolean {
  return pr.requestedTeams.includes(ASSETS_TEAM_SLUG)
}

/** Explicit outstanding request to an individual team member? */
export function hasMemberRequest(pr: TodayPr): boolean {
  return pr.requestedReviewers.some((login) => ROSTER_SET.has(login))
}

/** View 1 membership: non-draft PR with an explicit outstanding request to
 *  the team or a member. Drafts never qualify, no matter who requested. */
export function needsAssetsReview(pr: TodayPr): boolean {
  return !pr.draft && (hasTeamRequest(pr) || hasMemberRequest(pr))
}

/** View 2 membership: open, non-draft PR authored by a team member. */
export function assetsAuthored(pr: TodayPr): boolean {
  return !pr.draft && authorshipOf(pr) === 'internal'
}


/**
 * What (if anything) an Assets-authored PR is explicitly waiting on from
 * outside the team. Unknown team slugs stay unknown — we render the slug
 * itself and never guess a team from an author's affiliation.
 */
export interface AwaitingInfo {
  /** Outstanding requests to teams other than the Assets team. */
  otherTeams: string[]
  /** Outstanding requests to reviewers outside the roster. */
  otherReviewers: string[]
}

export function awaitingInfoOf(pr: TodayPr): AwaitingInfo {
  return {
    otherTeams: pr.requestedTeams.filter((slug) => slug !== ASSETS_TEAM_SLUG),
    otherReviewers: pr.requestedReviewers.filter((login) => !ROSTER_SET.has(login)),
  }
}

/** Simple next-action text derived only from cheap, list-visible fields.
 *  Drafts never reach rows (both views exclude them), so no draft case. */
export function nextActionOf(pr: TodayPr, view: 'needs' | 'awaiting'): string {
  if (view === 'needs') return 'Review requested'
  // Team-PR view: an outstanding request to the Assets team or one of its
  // members is an INTERNAL review need — the team can act on it right now —
  // so it takes priority over anything the PR waits on from outside.
  if (hasTeamRequest(pr) || hasMemberRequest(pr)) return 'Internal review requested'
  const { otherTeams, otherReviewers } = awaitingInfoOf(pr)
  if (otherTeams.length > 0) {
    return `Awaiting ${otherTeams.join(', ')}`
  }
  if (otherReviewers.length > 0) {
    return 'Awaiting outside reviewers'
  }
  // No outstanding request is visible: could be approved/awaiting author, or
  // simply unreviewed — we do not claim to know which.
  return 'No visible requests — check PR'
}

/** PR age in whole days (floor), from creation. */
export function prAgeDays(pr: TodayPr, nowMs: number): number {
  const created = Date.parse(pr.createdAt)
  if (Number.isNaN(created)) return 0
  return Math.max(0, Math.floor((nowMs - created) / 86_400_000))
}

export function formatAge(days: number): string {
  if (days <= 0) return 'today'
  if (days === 1) return '1 day'
  if (days < 31) return `${days} days`
  const months = Math.floor(days / 30)
  return months === 1 ? '~1 month' : `~${months} months`
}
