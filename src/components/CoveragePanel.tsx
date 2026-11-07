import { coverageWindowMonths, formatMonthKey, repoDisplayName } from '../data/format'
import type { CoverageEntry, DashboardData } from '../data/types'
import { coverageLookup, coverageSummary } from '../data/metrics'

interface CoveragePanelProps {
  data: DashboardData
  repos: string[]
}

/** A non-complete repo-month worth listing: a coverage entry, or the absence of one. */
export type ProblemEntry = CoverageEntry | { repo: string; month: string; status: 'missing' }

/** Most severe first so genuine failures aren't buried under pending backfill. */
const problemRank: Record<ProblemEntry['status'], number> = {
  error: 0,
  partial: 1,
  missing: 2,
  pending: 3,
  // 'complete' never appears in the result; ranked last if that ever changes.
  complete: Number.MAX_SAFE_INTEGER,
}

/**
 * Every non-complete repo-month the panel must disclose, most severe first:
 * all non-complete `coverage` entries (last-wins on duplicate repo|month) —
 * including entries outside the derived window, which stay listed rather
 * than hidden — plus every in-window repo-month the collector wrote no
 * coverage entry for at all ("missing"). The timeline's months-with-data
 * window is irrelevant here; this list is scoped to the collection window.
 */
export function coverageProblemEntries(
  coverage: CoverageEntry[],
  repos: string[],
  coverageMonths: string[],
): ProblemEntry[] {
  const lookup = coverageLookup(coverage)
  const problems: ProblemEntry[] = [...lookup.entries()].filter((c) => c.status !== 'complete')
  for (const month of coverageMonths) {
    for (const repo of repos) {
      if (!lookup.get(repo, month)) problems.push({ repo, month, status: 'missing' })
    }
  }
  problems.sort(
    (a, b) =>
      problemRank[a.status] - problemRank[b.status] ||
      a.month.localeCompare(b.month) ||
      a.repo.localeCompare(b.repo),
  )
  return problems
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

export function CoveragePanel({ data, repos }: CoveragePanelProps) {
  const lookup = coverageLookup(data.coverage)
  // The panel spans the FULL collection window (derived from data.range), not
  // the months-with-data window that scopes the timeline: months with no
  // collected data must stay visible here as Pending (or Missing, if the
  // collector wrote no coverage entry at all) instead of being silently
  // dropped. This is what makes methodology note "the gap is visible in
  // coverage" true in the rendered product.
  const coverageMonths = coverageWindowMonths(data.range)
  const summary = coverageSummary(data.coverage, repos, coverageMonths)
  // Every non-complete repo-month is listed (see coverageProblemEntries), so
  // no gap can hide — not out-of-window months, not missing coverage entries.
  const problemEntries = coverageProblemEntries(data.coverage, repos, coverageMonths)
  const windowNote = coverageMonths.length > 0
    ? `${formatMonthKey(coverageMonths[0]!)} – ${formatMonthKey(coverageMonths[coverageMonths.length - 1]!)}`
    : ''

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
      {windowNote && (
        <p className="section__note" style={{ marginTop: 8 }}>
          Covers the full collection window ({windowNote}) — every month in the captured
          range, including months with no collected data. Timeline sections show only months with
          data.
        </p>
      )}
      {coverageMonths.length === 0 && (
        <p className="section__note notice--warn" style={{ marginTop: 8 }}>
          The collection window could not be derived from the data range ({data.range.start} →{' '}
          {data.range.end}); nothing is being hidden — the grid below is empty for that reason.
        </p>
      )}
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
            {coverageMonths.map((month) => (
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
                <code>{repoDisplayName(c.repo)} · {formatMonthKey(c.month)}</code> —{' '}
                {c.status === 'missing'
                  ? 'missing coverage metadata'
                  : `${c.status}${c.detail ? `: ${c.detail}` : ''}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
