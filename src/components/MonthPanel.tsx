import { formatInt, formatISODate, formatMonthKey, repoDisplayName } from '../data/format'
import type { DashboardData } from '../data/types'
import { aggregateMonths, comparePrs, prsReviewedIn } from '../data/metrics'

const PR_LIST_CAP = 100

interface MonthPanelProps {
  data: DashboardData
  windowMonths: string[]
  selectedMonth: string
  onSelectMonth: (month: string) => void
  repoFilter: string | null
}

export function MonthPanel({ data, windowMonths, selectedMonth, onSelectMonth, repoFilter }: MonthPanelProps) {
  const monthAggregates = aggregateMonths(data.months, repoFilter, [selectedMonth])
  const monthAgg = monthAggregates[0]
  const repos = repoFilter ? [repoFilter] : Array.from(new Set(data.months.map((m) => m.repo))).sort()
  const prs = prsReviewedIn(data.prs, selectedMonth, repoFilter).sort(comparePrs)
  const shown = prs.slice(0, PR_LIST_CAP)
  const reviewedTotal = monthAgg ? monthAgg.internalReviewedPrs + monthAgg.externalReviewedPrs : 0

  return (
    <section className="section" aria-labelledby="month-panel-title">
      <div className="section__tools">
        <div>
          <h2 className="section__title" id="month-panel-title">
            Month details · {formatMonthKey(selectedMonth)}
            {repoFilter ? ` · ${repoDisplayName(repoFilter)}` : ' · all repositories'}
          </h2>
          <p className="section__desc">
            Drill-down for the selected month, respecting the repository filter.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label htmlFor="month-select" className="stat__label">Month</label>
          <select
            id="month-select"
            value={selectedMonth}
            onChange={(e) => onSelectMonth(e.target.value)}
          >
            {windowMonths.map((m) => (
              <option key={m} value={m}>
                {formatMonthKey(m)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mini-metrics" role="list" aria-label={`Metrics for ${formatMonthKey(selectedMonth)}`}>
        <div className="mini-metric" role="listitem">
          <div className="mini-metric__label">Internal reviewed</div>
          <div className="mini-metric__value">{formatInt(monthAgg?.internalReviewedPrs ?? 0)}</div>
        </div>
        <div className="mini-metric" role="listitem">
          <div className="mini-metric__label">External reviewed</div>
          <div className="mini-metric__value">{formatInt(monthAgg?.externalReviewedPrs ?? 0)}</div>
        </div>
        <div className="mini-metric" role="listitem">
          <div className="mini-metric__label">Review submissions</div>
          <div className="mini-metric__value">{formatInt(monthAgg?.reviewSubmissions ?? 0)}</div>
        </div>
        <div className="mini-metric" role="listitem">
          <div className="mini-metric__label">Reviewed & unmerged</div>
          <div className="mini-metric__value">{formatInt(monthAgg?.reviewedUnmergedPrs ?? 0)}</div>
        </div>
        <div className="mini-metric" role="listitem">
          <div className="mini-metric__label">Merged internal</div>
          <div className="mini-metric__value">{formatInt(monthAgg?.mergedInternalPrs ?? 0)}</div>
        </div>
        <div className="mini-metric" role="listitem">
          <div className="mini-metric__label">Merged external w/ review</div>
          <div className="mini-metric__value">{formatInt(monthAgg?.mergedExternalReviewedPrs ?? 0)}</div>
        </div>
      </div>

      <div className="table-scroll">
        <table className="data" aria-label={`Per-repository counts for ${formatMonthKey(selectedMonth)}`}>
          <caption className="hidden-visually">
            Per-repository counts for {formatMonthKey(selectedMonth)}
          </caption>
          <thead>
            <tr>
              <th scope="col">Repository</th>
              <th scope="col" className="num">Internal reviewed</th>
              <th scope="col" className="num">External reviewed</th>
              <th scope="col" className="num">Review submissions</th>
              <th scope="col" className="num">Reviewed & unmerged</th>
              <th scope="col" className="num">Merged internal</th>
              <th scope="col" className="num">Merged external w/ review</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => {
              const row = data.months.find((m) => m.repo === repo && m.month === selectedMonth)
              const dash = (v: number | undefined) => (v === undefined ? '—' : formatInt(v))
              return (
                <tr key={repo}>
                  <th scope="row">{repoDisplayName(repo)}</th>
                  <td className="num">{dash(row?.internalReviewedPrs)}</td>
                  <td className="num">{dash(row?.externalReviewedPrs)}</td>
                  <td className="num">{dash(row?.reviewSubmissions)}</td>
                  <td className="num">{dash(row?.reviewedUnmergedPrs)}</td>
                  <td className="num">{dash(row?.mergedInternalPrs)}</td>
                  <td className="num">{dash(row?.mergedExternalReviewedPrs)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <h3 className="section__title" style={{ marginTop: 18, fontSize: 14 }}>
        PRs reviewed in {formatMonthKey(selectedMonth)}
      </h3>
      {shown.length === 0 ? (
        <p className="section__note">
          No PR-level records for this month{repoFilter ? ' in this repository' : ''}.
          {reviewedTotal > 0
            ? ` Aggregate counts report ${formatInt(reviewedTotal)} reviewed PRs; the PR-level list is incomplete.`
            : ''}
        </p>
      ) : (
        <>
          <div className="table-scroll">
            <table className="data" aria-label={`PRs reviewed in ${formatMonthKey(selectedMonth)}`}>
              <caption className="hidden-visually">
                Pull requests reviewed in {formatMonthKey(selectedMonth)}, minimal metadata only
              </caption>
              <thead>
                <tr>
                  <th scope="col">PR</th>
                  <th scope="col">Title</th>
                  <th scope="col">Ownership</th>
                  <th scope="col">State</th>
                  <th scope="col">Merged</th>
                  <th scope="col">Labels</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((pr) => (
                  <tr key={pr.id}>
                    <th scope="row">
                      <a className="pr-link" href={pr.url} target="_blank" rel="noopener noreferrer">
                        {repoDisplayName(pr.repo)} #{pr.number}
                      </a>
                    </th>
                    <td>{pr.title}</td>
                    <td>
                      <span
                        className={`chip chip--${pr.ownership}`}
                        title={
                          pr.ownershipReason === 'team-label'
                            ? 'Attributed via team-assets label'
                            : pr.ownershipReason === 'team-author'
                              ? 'Attributed via supplied author roster'
                              : 'Other attribution'
                        }
                      >
                        {pr.ownership}
                      </span>
                    </td>
                    <td>
                      <span className={`chip chip--${pr.state.toLowerCase()}`}>{pr.state.toLowerCase()}</span>
                    </td>
                    <td>{pr.mergedAt ? formatISODate(pr.mergedAt) : '—'}</td>
                    <td>
                      {pr.labels.slice(0, 3).map((l) => (
                        <span key={l} className="chip" style={{ marginRight: 4 }}>{l}</span>
                      ))}
                      {pr.labels.length > 3 && <span className="chip chip--missing">+{pr.labels.length - 3}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {prs.length > shown.length && (
            <p className="section__note">
              Showing {formatInt(shown.length)} of {formatInt(prs.length)} PRs.
            </p>
          )}
          {shown.length < reviewedTotal && (
            <p className="section__note">
              PR-level records cover {formatInt(shown.length)} of {formatInt(reviewedTotal)} reviewed
              PRs counted in the aggregates for this month; the list is incomplete.
            </p>
          )}
        </>
      )}
    </section>
  )
}
