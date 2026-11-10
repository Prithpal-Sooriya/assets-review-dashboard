import { StackedSeriesChart } from '../charts/StackedSeriesChart'
import { MonthDataTable } from './MonthDataTable'
import { formatInt } from '../data/format'
import { reviewerMonths } from '../data/metrics'
import type { ReviewerMonthEntry } from '../data/types'

interface ReviewerSectionProps {
  rows: ReviewerMonthEntry[] | undefined
  repoFilter: string | null
  windowMonths: string[]
}

function seriesColor(index: number): string {
  return `var(--series-${(index % 8) + 1})`
}

export function ReviewerSection({ rows, repoFilter, windowMonths }: ReviewerSectionProps) {
  const { months, logins } = reviewerMonths(rows, repoFilter, windowMonths)
  if (logins.length === 0) return null

  const submissions = logins.map((login) =>
    months.reduce((sum, month) => sum + (month.people.find((p) => p.login === login)?.reviewSubmissions ?? 0), 0),
  )
  const prs = logins.map((login) =>
    months.reduce((sum, month) => sum + (month.people.find((p) => p.login === login)?.reviewedPrs ?? 0), 0),
  )
  const totalSubmissions = submissions.reduce((a, b) => a + b, 0)
  const widest = Math.max(0, ...submissions)
  const leaders = logins.filter((_, i) => submissions[i] === widest && widest > 0)
  const share = totalSubmissions > 0 ? Math.round((widest / totalSubmissions) * 100) : 0

  return (
    <section className="section" aria-labelledby="reviewers-title">
      <h2 className="section__title" id="reviewers-title">
        Who on the team reviewed
      </h2>
      <p className="section__desc">
        Qualifying review submissions by each person on the Assets roster, per month. A pull
        request reviewed twice by the same person counts as two submissions and one pull request.
        Self-reviews and excluded reviewers are omitted. Someone with a quiet month is shown at zero.
      </p>
      <StackedSeriesChart
        months={months.map((m) => m.month)}
        series={logins.map((login, i) => ({
          key: login,
          label: login,
          color: seriesColor(i),
          values: months.map((m) => m.people.find((p) => p.login === login)?.reviewSubmissions ?? 0),
        }))}
        label={`Review submissions by roster member across ${months.length} months, ${formatInt(totalSubmissions)} submissions in total.`}
      />
      <div className="chart-legend" aria-hidden="true">
        {logins.map((login, i) => (
          <span key={login}>
            <span className="swatch" style={{ background: seriesColor(i) }} />
            {login}
          </span>
        ))}
      </div>
      {totalSubmissions > 0 && (
        <p className="section__note">
          Widest share this window: {leaders.join(' and ')}, {share}% of submissions ({formatInt(widest)} of{' '}
          {formatInt(totalSubmissions)}).
        </p>
      )}
      <MonthDataTable
        summary="View submissions as a table"
        caption="Review submissions by roster member and month"
        months={months.map((m) => m.month)}
        columns={logins.map((login, i) => ({
          key: login,
          header: login,
          cells: months.map((m) => formatInt(m.people.find((p) => p.login === login)?.reviewSubmissions ?? 0)),
          total: formatInt(submissions[i] ?? 0),
        }))}
      />
      <MonthDataTable
        summary="View pull requests as a table"
        caption="Distinct pull requests reviewed by roster member and month"
        months={months.map((m) => m.month)}
        columns={logins.map((login, i) => ({
          key: `${login}-prs`,
          header: `${login} PRs`,
          cells: months.map((m) => formatInt(m.people.find((p) => p.login === login)?.reviewedPrs ?? 0)),
          total: formatInt(prs[i] ?? 0),
        }))}
      />
    </section>
  )
}
