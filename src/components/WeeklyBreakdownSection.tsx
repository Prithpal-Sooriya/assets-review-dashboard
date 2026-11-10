import { GroupedBarChart } from '../charts/GroupedBarChart'
import { DataTable, type DataColumn } from './ChartTable'
import { formatInt, formatWeekLabel, formatWeekTick } from '../data/format'
import { aggregateWeeks, weekPeriods, type WeekAggregate } from '../data/metrics'
import type { WeekEntry } from '../data/types'

interface WeeklyBreakdownSectionProps {
  weeks: WeekEntry[]
  windowMonths: string[]
  repoFilter: string | null
}

interface WeekRowView extends WeekAggregate {
  key: string
}

const columns: DataColumn<WeekRowView>[] = [
  { key: 'ir', header: 'Internal reviewed', value: (a) => formatInt(a.internalReviewedPrs), total: (a) => a.internalReviewedPrs },
  { key: 'er', header: 'External reviewed', value: (a) => formatInt(a.externalReviewedPrs), total: (a) => a.externalReviewedPrs },
  { key: 'sub', header: 'Review submissions', value: (a) => formatInt(a.reviewSubmissions), total: (a) => a.reviewSubmissions },
  { key: 'un', header: 'Reviewed & unmerged', value: (a) => formatInt(a.reviewedUnmergedPrs), total: (a) => a.reviewedUnmergedPrs },
  { key: 'mi', header: 'Merged internal', value: (a) => formatInt(a.mergedInternalPrs), total: (a) => a.mergedInternalPrs },
  { key: 'me', header: 'Merged external (reviewed)', value: (a) => formatInt(a.mergedExternalReviewedPrs), total: (a) => a.mergedExternalReviewedPrs },
]

/**
 * The monthly timeline, counted on ISO weeks. Submissions and merges in the
 * table sum to the monthly figures; a PR reviewed in two weeks counts in both.
 */
export function WeeklyBreakdownSection({ weeks, windowMonths, repoFilter }: WeeklyBreakdownSectionProps) {
  const periods = weekPeriods(weeks, windowMonths)
  const aggregates = aggregateWeeks(weeks, repoFilter, periods)
  const rows: WeekRowView[] = aggregates.map((a) => ({ ...a, key: a.week }))
  const partialCount = aggregates.filter((a) => a.partial).length
  const reviewed = aggregates.reduce((s, a) => s + a.internalReviewedPrs + a.externalReviewedPrs, 0)
  const showYear = (index: number): boolean => {
    const start = aggregates[index]?.weekStart
    if (!start) return false
    const year = new Date(start).getUTCFullYear()
    if (index === 0) return true
    const prev = aggregates[index - 1]?.weekStart
    return !prev || new Date(prev).getUTCFullYear() !== year
  }

  return (
    <section className="section" aria-labelledby="weekly-title">
      <h2 className="section__title" id="weekly-title">
        Reviewed PRs per week
      </h2>
      <p className="section__desc">
        The same reviewed-pull-request counts as the monthly chart, on ISO weeks (Monday to
        Sunday, UTC). A pull request reviewed in two weeks counts once in each. Review
        submissions and merges each fall in a single week, so those totals match the months.
      </p>
      {aggregates.length === 0 ? (
        <p className="section__note">
          No weekly rows in this window. A week is included only when at least one month it
          overlaps was fully collected.
        </p>
      ) : (
        <>
          <GroupedBarChart
            months={aggregates.map((a) => a.week)}
            minGroupPx={28}
            formatTick={(key, index) => formatWeekTick(aggregates[index]?.weekStart ?? key, showYear(index))}
            ariaLabel={`Reviewed pull requests per week: ${formatInt(reviewed)} across ${aggregates.length} weeks, ${formatInt(aggregates.reduce((s, a) => s + a.internalReviewedPrs, 0))} internal and ${formatInt(aggregates.reduce((s, a) => s + a.externalReviewedPrs, 0))} external.`}
            series={[
              { key: 'internal', label: 'Internal PRs reviewed', color: 'var(--accent)', values: aggregates.map((a) => a.internalReviewedPrs) },
              { key: 'external', label: 'External PRs reviewed', color: 'var(--teal-bar)', values: aggregates.map((a) => a.externalReviewedPrs) },
            ]}
          />
          <div className="chart-legend" aria-hidden="true">
            <span><span className="swatch" style={{ background: 'var(--accent)' }} />Internal (team-owned)</span>
            <span><span className="swatch" style={{ background: 'var(--teal-bar)' }} />External</span>
          </div>
          <p className="section__note">
            {partialCount > 0
              ? `${partialCount} week${partialCount === 1 ? ' is' : 's are'} partial: clipped by the window start or the data cutoff, or overlapping a month that was not fully collected. `
              : ''}
            Scroll the chart sideways when the window is longer than the page. Counts for partial
            weeks can understate activity.
          </p>
          <DataTable
            caption="Reviewed pull requests, review submissions, unmerged snapshot and merges by ISO week"
            rows={rows}
            columns={columns}
            rowHeader="Week"
            label={(row) => formatWeekLabel(row.week, row.weekStart, row.partial)}
            showTotals
          />
        </>
      )}
    </section>
  )
}
