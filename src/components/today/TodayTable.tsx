import { useMemo } from 'react'
import { repoDisplayName } from '../../data/format'
import { ASSETS_TEAM_SLUG } from '../../today/config'
import { authorshipOf, formatAge, nextActionOf } from '../../today/classify'
import type { Row } from '../../today/table'
import type { TodayUrlState } from '../../today/urlstate'
import type { AuthMode } from '../../today/normalize'

/**
 * The main Today table. Accessible by construction: real table semantics,
 * scope=col headers, aria-sort on the active sort, PR links open GitHub.
 * Desktop-first; horizontal scroll on narrow viewports (.table-scroll).
 */
export function TodayTable({
  groups,
  state,
  authMode,
  onSort,
}: {
  groups: { groupKey: string; rows: Row[] }[]
  state: TodayUrlState
  authMode: AuthMode
  onSort: (sort: TodayUrlState['sort']) => void
}) {
  // Actual sort directions: repo/author compare ascending; 'oldest' is age
  // descending (biggest age first); 'newest' is age ascending. The aria-sort
  // value and the arrow must match the real order.
  const SORT_DIRECTION: Record<TodayUrlState['sort'], 'ascending' | 'descending'> = {
    repo: 'ascending',
    author: 'ascending',
    oldest: 'descending',
    newest: 'ascending',
  }

  const sortButton = (key: TodayUrlState['sort'], label: string) => (
    <th scope="col" aria-sort={state.sort === key ? SORT_DIRECTION[key] : 'none'}>
      <button type="button" className="th-sort" onClick={() => onSort(key)}>
        {label}
        {state.sort === key ? (SORT_DIRECTION[key] === 'ascending' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  )

  const ageHeader = (
    <th
      scope="col"
      aria-sort={
        state.sort === 'oldest' || state.sort === 'newest' ? SORT_DIRECTION[state.sort] : 'none'
      }
      className="num"
    >
      <button
        type="button"
        className="th-sort"
        onClick={() => onSort(state.sort === 'oldest' ? 'newest' : 'oldest')}
      >
        PR age
        {state.sort === 'oldest' ? ' ↓' : state.sort === 'newest' ? ' ↑' : ''}
      </button>
    </th>
  )

  const emptyMessage =
    state.view === 'needs'
      ? authMode === 'anonymous'
        ? 'No outstanding review requests visible. Without a token GitHub hides team review requests, so this list only shows direct requests to team members — it may be incomplete rather than truly empty.'
        : 'No outstanding review requests to the Assets team or its members right now.'
      : 'No open pull requests authored by the Assets team right now.'

  return (
    <div className="table-scroll">
      <table className="data today-table">
        <caption className="hidden-visually">
          {state.view === 'needs'
            ? 'Open pull requests with outstanding review requests to the Assets team'
            : 'Open pull requests authored by the Assets team'}
        </caption>
        <thead>
          <tr>
            {sortButton('repo', 'Repository')}
            <th scope="col">Pull request</th>
            {sortButton('author', 'Author')}
            <th scope="col">Requested</th>
            <th scope="col">Next action</th>
            {ageHeader}
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.groupKey}>
            {state.group !== 'none' && (
              <tr className="today-group-row">
                <th scope="rowgroup" colSpan={6} className="today-group-head">
                  {state.group === 'repo' ? repoDisplayName(group.groupKey) : group.groupKey}
                  <span className="today-group-count"> · {group.rows.length}</span>
                </th>
              </tr>
            )}
            {group.rows.map(({ pr, ageDays }) => {
              const ownership = authorshipOf(pr)
              return (
                <tr key={`${pr.repo}#${pr.number}`}>
                  <td>{repoDisplayName(pr.repo)}</td>
                  <td>
                    <a className="pr-link" href={pr.url} target="_blank" rel="noreferrer">
                      #{pr.number}
                    </a>{' '}
                    {pr.title}
                    {pr.draft && (
                      <span className="chip chip--closed" style={{ marginLeft: 8 }} title="Draft pull request">
                        Draft
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`chip chip--${ownership === 'internal' ? 'internal' : 'external'}`}>
                      {pr.author}
                    </span>
                  </td>
                  <td className="today-requested">
                    {pr.requestedTeams
                      .slice()
                      .sort((a, b) => (a === ASSETS_TEAM_SLUG ? -1 : b === ASSETS_TEAM_SLUG ? 1 : a.localeCompare(b)))
                      .map((slug) => (
                        <span
                          key={slug}
                          className={`chip${slug === ASSETS_TEAM_SLUG ? ' chip--internal' : ' chip--external'}`}
                          title={slug === ASSETS_TEAM_SLUG ? 'The Assets team' : 'Other team (shown by GitHub slug)'}
                        >
                          {slug === ASSETS_TEAM_SLUG ? 'Assets team' : slug}
                        </span>
                      ))}
                    {pr.requestedReviewers.map((login) => (
                      <span key={login} className="chip chip--open" title="Direct reviewer request">
                        {login}
                      </span>
                    ))}
                    {pr.requestedTeams.length === 0 && pr.requestedReviewers.length === 0 && (
                      <span className="section__note">—</span>
                    )}
                  </td>
                  <td>{nextActionOf(pr, state.view)}</td>
                  <td className="num" title={`Created ${pr.createdAt}`}>
                    {formatAge(ageDays)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        ))}
        {groups.every((g) => g.rows.length === 0) && (
          <tbody>
            <tr>
              <td colSpan={6} className="today-empty">
                {emptyMessage}
              </td>
            </tr>
          </tbody>
        )}
      </table>
    </div>
  )
}
