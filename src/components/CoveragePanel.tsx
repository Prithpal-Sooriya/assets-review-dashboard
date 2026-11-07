import { formatMonthKey, repoDisplayName } from '../data/format'
import type { CoverageEntry, DashboardData } from '../data/types'
import { coverageLookup, coverageSummary } from '../data/metrics'

interface CoveragePanelProps {
  data: DashboardData
  repos: string[]
  windowMonths: string[]
}

function statusChip(entry: CoverageEntry | undefined): { label: string; cls: string } {
  switch (entry?.status) {
    case 'complete': return { label: 'Complete', cls: 'chip--complete' }
    case 'partial': return { label: 'Partial', cls: 'chip--partial' }
    case 'pending': return { label: 'Pending', cls: 'chip--pending' }
    case 'error': return { label: 'Error', cls: 'chip--error' }
    default: return { label: 'Missing', cls: 'chip--missing' }
  }
}

export function CoveragePanel({ data, repos, windowMonths }: CoveragePanelProps) {
  const lookup = coverageLookup(data.coverage)
  const summary = coverageSummary(data.coverage, repos, windowMonths)
  const problemEntries = data.coverage
    .filter((c) => windowMonths.includes(c.month) && c.status !== 'complete')
    .sort((a, b) => a.month.localeCompare(b.month) || a.repo.localeCompare(b.repo))

  return (
    <section className="section" aria-labelledby="coverage-title">
      <h2 className="section__title" id="coverage-title">
        Data coverage
      </h2>
      <p className="section__desc">
        Completeness of the collection run per repository and month. Counts for months that are
        not complete may understate activity — historical GitHub search is known to lose
        dismissed-review evidence and caps deep pagination, so treat non-complete cells as lower
        bounds.
      </p>
      <p className="section__note" style={{ marginTop: 8 }}>
        {summary.complete}/{summary.total} repo-months complete
        {summary.partial > 0 && ` · ${summary.partial} partial`}
        {summary.pending > 0 && ` · ${summary.pending} pending`}
        {summary.error > 0 && ` · ${summary.error} error`}
        {summary.missing > 0 && ` · ${summary.missing} missing coverage metadata`}
      </p>
      <div className="table-scroll">
        <table className="data">
          <caption className="hidden-visually">Collection completeness by repository and month</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              {repos.map((repo) => (
                <th key={repo} scope="col">{repoDisplayName(repo)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {windowMonths.map((month) => (
              <tr key={month}>
                <th scope="row">{formatMonthKey(month)}</th>
                {repos.map((repo) => {
                  const entry = lookup.get(repo, month)
                  const chip = statusChip(entry)
                  return (
                    <td key={repo}>
                      <span className={`chip ${chip.cls}`} title={entry?.detail ?? undefined}>
                        {chip.label}
                      </span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {problemEntries.length > 0 && (
        <>
          <h3 className="section__title" style={{ marginTop: 16, fontSize: 13.5 }}>
            Incomplete months
          </h3>
          <ul className="issue-list">
            {problemEntries.map((c) => (
              <li key={`${c.repo}|${c.month}`}>
                <code>{repoDisplayName(c.repo)} · {formatMonthKey(c.month)}</code> — {c.status}
                {c.detail ? `: ${c.detail}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
