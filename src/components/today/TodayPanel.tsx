import { useCallback, useEffect, useMemo, useState } from 'react'
import { repoDisplayName } from '../../data/format'
import { useTodayData } from '../../today/useTodayData'
import { buildRows, viewCounts } from '../../today/table'
import {
  applyHash,
  buildTodayHash,
  parseHash,
  type TodayUrlState,
} from '../../today/urlstate'
import { TODAY_REPOS } from '../../today/config'
import type { AuthMode } from '../../today/normalize'
import { TokenCard } from './TokenCard'
import { TodayStatus } from './TodayStatus'
import { TodayTable } from './TodayTable'
import { SinceBaselineCard } from './SinceBaselineCard'

/**
 * Daily page (the "Daily review queue"): client-only collection from public
 * GitHub REST data, mounted at / (legacy #/today hash links still land here).
 *
 * Views (Team PRs first — the default landing):
 *  - "Team PRs" — ALL open, non-draft PRs authored by team members, including
 *    internal review needs (outstanding requests to the team or its members)
 *    and what each PR waits on from outside.
 *  - "Review requests" — open, non-draft PRs with an explicit outstanding
 *    review request to the metamask-assets team or its members (authorship
 *    is irrelevant here; team PRs with internal requests appear in both).
 *
 * Draft PRs are excluded from both views and their counts. All filters,
 * grouping and sort live in the URL hash (shareable). Anonymous mode carries
 * an explicit incompleteness warning because GitHub hides team review
 * requests from unauthenticated API calls.
 */
export function TodayPanel() {
  const today = useTodayData()
  const [urlState, setUrlState] = useState<TodayUrlState>(() => parseHash(window.location.hash))
  const [nowMs, setNowMs] = useState(() => Date.now())

  // Hash is the source of truth: back/forward and shared links both land here.
  useEffect(() => {
    const onHash = () => setUrlState(parseHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Re-render periodically so data age stays honest without collection.
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  const update = useCallback((patch: Partial<TodayUrlState>) => {
    setUrlState((prev) => {
      const next = { ...prev, ...patch }
      applyHash(buildTodayHash(next))
      return next
    })
  }, [])

  const display = today.display
  const counts = useMemo(() => (display !== null ? viewCounts(display.prs) : { needs: 0, awaiting: 0 }), [display])
  const groups = useMemo(
    () => (display !== null ? buildRows(display.prs, urlState, nowMs) : []),
    [display, urlState, nowMs],
  )

  const authMode: AuthMode = today.authMode
  // The notice describes the DATA being shown: anonymous GitHub responses
  // omit team review requests entirely, which affects BOTH views (the
  // review-requests list may be missing rows, and a team PR with an invisible
  // team request renders as “No visible requests”). A cached token-collected
  // snapshot legitimately contains team requests even while the live token
  // slot is empty (memory-only token, page reloaded).
  const anonymousLimited = display !== null && display.authMode === 'anonymous'

  return (
    <>
      <section className="section" aria-labelledby="daily-queue-heading">
        <h2 className="section__title" id="daily-queue-heading">Daily review queue</h2>
        <p className="section__desc">
          The team&rsquo;s own open PRs — including internal review needs — plus explicit
          review requests to the Assets team or its members, across MetaMask Core, Mobile and
          Extension. Draft PRs are never listed. Collected live in this browser from public
          GitHub data — see the status card below for how fresh it is.
        </p>
      </section>
      <TodayStatus today={today} nowMs={nowMs} />

      {display === null && !today.collecting && (
        <div className="state-card notice notice--error" role="alert" style={{ display: 'block' }}>
          <h2 style={{ color: 'var(--danger)' }}>No Daily data available</h2>
          <p>
            Nothing has been collected yet and there is no cached snapshot in this browser. The
            dashboard collects from api.github.com while this page is open; check the banner above
            for the reason collection did not complete.
          </p>
        </div>
      )}

      <section className="section" aria-label="Daily views">
        <div className="section__tools">
          <div className="segmented" role="group" aria-label="Daily view">
            <button
              type="button"
              className="btn"
              aria-pressed={urlState.view === 'awaiting'}
              onClick={() => update({ view: 'awaiting' })}
            >
              Team PRs ({counts.awaiting})
            </button>
            <button
              type="button"
              className="btn"
              aria-pressed={urlState.view === 'needs'}
              onClick={() => update({ view: 'needs' })}
            >
              Review requests ({counts.needs})
            </button>
          </div>
          <div className="segmented" role="group" aria-label="Repository filter">
            <button
              type="button"
              className="btn"
              aria-pressed={urlState.repo === null}
              onClick={() => update({ repo: null })}
            >
              All repos
            </button>
            {TODAY_REPOS.map(
              (repo) => (
                <button
                  key={repo}
                  type="button"
                  className="btn"
                  aria-pressed={urlState.repo === repo}
                  onClick={() => update({ repo: repo === urlState.repo ? null : repo })}
                >
                  {repoDisplayName(repo)}
                </button>
              ),
            )}
          </div>
          {urlState.view === 'needs' && (
            <div className="segmented" role="group" aria-label="Authorship filter">
              {(['all', 'internal', 'external'] as const).map((author) => (
                <button
                  key={author}
                  type="button"
                  className="btn"
                  aria-pressed={urlState.author === author}
                  onClick={() => update({ author })}
                >
                  {author === 'all' ? 'All authors' : author === 'internal' ? 'Team authors' : 'External authors'}
                </button>
              ))}
            </div>
          )}
          <div className="segmented" role="group" aria-label="Grouping">
            {(['repo', 'team', 'none'] as const).map((group) => (
              <button
                key={group}
                type="button"
                className="btn"
                aria-pressed={urlState.group === group}
                onClick={() => update({ group })}
              >
                {group === 'repo' ? 'Group: repo' : group === 'team' ? 'Group: requested team' : 'No grouping'}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="Sort order">
            {(['oldest', 'newest'] as const).map((sort) => (
              <button
                key={sort}
                type="button"
                className="btn"
                aria-pressed={urlState.sort === sort}
                onClick={() => update({ sort })}
              >
                {sort === 'oldest' ? 'Oldest first' : 'Newest first'}
              </button>
            ))}
          </div>
        </div>
        <p className="section__note">
          {urlState.view === 'awaiting'
            ? `Open, non-draft PRs authored by Assets team members — including those with internal review requests (shown per row). Every team PR is listed, even with no visible request; nothing here implies a request that GitHub does not show.${counts.needs > 0 ? ` ${counts.needs} explicit review request${counts.needs === 1 ? ' is' : 's are'} open to the team or its members — see the Review requests view.` : ''}`
            : 'Open, non-draft PRs with an explicit outstanding review request to the Assets team or one of its members — from outside authors or from team members’ own PRs (those also appear in Team PRs, so counts can overlap). Ownership labels or authorship alone never qualify a PR.'}
        </p>
      </section>

      {display !== null && <TodayTable groups={groups} state={urlState} authMode={authMode} onSort={(sort) => update({ sort })} />}

      {anonymousLimited && (
        <div className="notice notice--warn" role="status">
          <span className="notice__label">Limited visibility</span>
          <div className="notice__body">
            <p>
              Without a token, GitHub hides team review requests from the API, so only{' '}
              <strong>direct reviewer requests</strong> to team members are visible. Rows and
              &ldquo;No visible requests&rdquo; labels may be incomplete rather than truly empty —
              add an optional read-only token below to see team requests.
            </p>
          </div>
        </div>
      )}

      <TokenCard today={today} />

      {today.usableBaseline !== null && display !== null && display.complete && (
        <SinceBaselineCard baseline={today.usableBaseline} current={display} />
      )}
      {today.usableBaseline !== null && display !== null && !display.complete && (
        <p className="section__note">
          Since-baseline comparison suspended: the latest collection is incomplete, so left-the-queue
          counts would be misleading.
        </p>
      )}

      <section className="section" aria-label="How this data is collected">
        <h2 className="section__title">About this data</h2>
        <p className="section__desc">
          Collected in your browser from the public GitHub REST API (api.github.com) for the three
          configured public repositories, refreshing roughly every 3 hours while the page is open.
          The anonymous rate budget is shared per network and small; the dashboard refuses to
          spend it when a full sweep will not fit and keeps the last complete snapshot on failure.
          Missing PRs are never assumed merged — only verified states are labelled merged or
          closed. No assignment, statistics, Slack or webhook features exist here.
        </p>
      </section>
    </>
  )
}
