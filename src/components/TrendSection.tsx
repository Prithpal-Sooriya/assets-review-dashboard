import { GroupedBarChart } from '../charts/GroupedBarChart'
import { StackedSeriesChart } from '../charts/StackedSeriesChart'
import { MonthDataTable } from './MonthDataTable'
import { formatDurationMinutes, formatInt } from '../data/format'
import { trendMonths } from '../data/metrics'
import type { TrendMonthEntry } from '../data/types'

interface TrendSectionProps {
  rows: TrendMonthEntry[] | undefined
  repoFilter: string | null
  windowMonths: string[]
}

export function TrendSection({ rows, repoFilter, windowMonths }: TrendSectionProps) {
  const trends = trendMonths(rows, repoFilter, windowMonths)
  if (trends.length === 0) return null
  const months = trends.map((t) => t.month)

  const reviewed = trends.reduce((s, t) => s + t.reviewedPrs, 0)
  const multi = trends.reduce((s, t) => s + t.multiReviewerPrs, 0)
  const sized = trends.reduce((s, t) => s + t.sizedReviewedPrs, 0)
  const multiShare = reviewed > 0 ? Math.round((multi / reviewed) * 100) : 0

  return (
    <section className="section" aria-labelledby="trends-title">
      <h2 className="section__title" id="trends-title">
        How the team reviewed
      </h2>
      <p className="section__desc">
        Outcome mix, how long pull requests waited, how often more than one person reviewed, and
        how large the diffs were. Medians, not means, so one pull request that sat for weeks does
        not set the month. A partial month runs only through the collection cutoff.
      </p>

      <h3 className="section__title" style={{ fontSize: 14, marginTop: 16 }}>
        Review outcomes
      </h3>
      <p className="section__note" style={{ marginTop: 2 }}>
        Submissions by state. Dismissed means the review was submitted and later dismissed.
      </p>
      <StackedSeriesChart
        months={months}
        series={[
          { key: 'approved', label: 'Approved', color: 'var(--teal-bar)', values: trends.map((t) => t.approvals) },
          { key: 'changes', label: 'Changes requested', color: 'var(--amber-bar)', values: trends.map((t) => t.changesRequested) },
          { key: 'comments', label: 'Commented', color: 'var(--accent)', values: trends.map((t) => t.comments) },
          { key: 'dismissed', label: 'Dismissed', color: 'var(--neutral-bar)', values: trends.map((t) => t.dismissed) },
        ]}
      />
      <div className="chart-legend" aria-hidden="true">
        <span><span className="swatch" style={{ background: 'var(--teal-bar)' }} />Approved</span>
        <span><span className="swatch" style={{ background: 'var(--amber-bar)' }} />Changes requested</span>
        <span><span className="swatch" style={{ background: 'var(--accent)' }} />Commented</span>
        <span><span className="swatch" style={{ background: 'var(--neutral-bar)' }} />Dismissed</span>
      </div>
      <MonthDataTable
        summary="View outcomes as a table"
        caption="Review submissions by outcome and month"
        months={months}
        columns={[
          { key: 'approved', header: 'Approved', cells: trends.map((t) => formatInt(t.approvals)), total: formatInt(trends.reduce((s, t) => s + t.approvals, 0)) },
          { key: 'changes', header: 'Changes requested', cells: trends.map((t) => formatInt(t.changesRequested)), total: formatInt(trends.reduce((s, t) => s + t.changesRequested, 0)) },
          { key: 'comments', header: 'Commented', cells: trends.map((t) => formatInt(t.comments)), total: formatInt(trends.reduce((s, t) => s + t.comments, 0)) },
          { key: 'dismissed', header: 'Dismissed', cells: trends.map((t) => formatInt(t.dismissed)), total: formatInt(trends.reduce((s, t) => s + t.dismissed, 0)) },
        ]}
      />

      <h3 className="section__title" style={{ fontSize: 14, marginTop: 18 }}>
        Time to first review, and from review to merge
      </h3>
      <p className="section__note" style={{ marginTop: 2 }}>
        First review is measured from pull request creation, so time spent in draft is included.
        Review-to-merge starts at the earliest qualifying review at or before merge. A month with
        no sample has no bar.
      </p>
      <GroupedBarChart
        months={months}
        formatYTick={(n) => formatDurationMinutes(n)}
        series={[
          {
            key: 'first',
            label: 'Median time to first review',
            color: 'var(--accent)',
            values: trends.map((t) => t.medianMinutesToFirstReview ?? 0),
          },
          {
            key: 'merge',
            label: 'Median time from review to merge',
            color: 'var(--teal-bar)',
            values: trends.map((t) => t.medianMinutesReviewToMerge ?? 0),
          },
        ]}
      />
      <div className="chart-legend" aria-hidden="true">
        <span><span className="swatch" style={{ background: 'var(--accent)' }} />To first review</span>
        <span><span className="swatch" style={{ background: 'var(--teal-bar)' }} />Review to merge</span>
      </div>
      <MonthDataTable
        summary="View pace as a table"
        caption="Median minutes to first review and from review to merge"
        months={months}
        columns={[
          {
            key: 'first',
            header: 'To first review',
            cells: trends.map((t) => formatDurationMinutes(t.medianMinutesToFirstReview)),
          },
          {
            key: 'first-n',
            header: 'First reviews',
            cells: trends.map((t) => formatInt(t.firstReviews)),
            total: formatInt(trends.reduce((s, t) => s + t.firstReviews, 0)),
          },
          {
            key: 'merge',
            header: 'Review to merge',
            cells: trends.map((t) => formatDurationMinutes(t.medianMinutesReviewToMerge)),
          },
          {
            key: 'merge-n',
            header: 'Reviewed merges',
            cells: trends.map((t) => formatInt(t.reviewedMerges)),
            total: formatInt(trends.reduce((s, t) => s + t.reviewedMerges, 0)),
          },
        ]}
      />

      <h3 className="section__title" style={{ fontSize: 14, marginTop: 18 }}>
        More than one reviewer
      </h3>
      <p className="section__note" style={{ marginTop: 2 }}>
        {reviewed > 0
          ? `${formatInt(multi)} of ${formatInt(reviewed)} reviewed pull requests (${multiShare}%) had qualifying reviews from two or more roster members in the same month.`
          : 'No reviewed pull requests in this window.'}
      </p>
      <GroupedBarChart
        months={months}
        series={[
          { key: 'reviewed', label: 'Reviewed pull requests', color: 'var(--accent)', values: trends.map((t) => t.reviewedPrs) },
          { key: 'multi', label: 'Reviewed by two or more people', color: 'var(--teal-bar)', values: trends.map((t) => t.multiReviewerPrs) },
        ]}
      />
      <div className="chart-legend" aria-hidden="true">
        <span><span className="swatch" style={{ background: 'var(--accent)' }} />Reviewed</span>
        <span><span className="swatch" style={{ background: 'var(--teal-bar)' }} />Two or more reviewers</span>
      </div>

      <h3 className="section__title" style={{ fontSize: 14, marginTop: 18 }}>
        Pull request size
      </h3>
      {sized === 0 ? (
        <p className="section__note" style={{ marginTop: 2 }}>
          Line and file counts are not in the snapshots behind this view. The collector now records
          additions, deletions, and files changed for pull requests the roster reviewed. Closed
          months stay without size until those snapshots are enriched. No size figures are shown
          for this window.
        </p>
      ) : (
        <>
          <p className="section__note" style={{ marginTop: 2 }}>
            Changed lines are additions plus deletions on the collected snapshot, not the diff the
            reviewer necessarily saw. Size is known for {formatInt(sized)} of {formatInt(reviewed)}{' '}
            reviewed pull requests. Buckets are under 100, 100–499, 500–999, and 1000 or more lines.
          </p>
          <StackedSeriesChart
            months={months}
            series={[
              { key: 'small', label: 'Under 100 lines', color: 'var(--teal-bar)', values: trends.map((t) => t.sizeSmall) },
              { key: 'medium', label: '100–499 lines', color: 'var(--accent)', values: trends.map((t) => t.sizeMedium) },
              { key: 'large', label: '500–999 lines', color: 'var(--amber-bar)', values: trends.map((t) => t.sizeLarge) },
              { key: 'xlarge', label: '1000 or more lines', color: 'var(--series-4)', values: trends.map((t) => t.sizeXLarge) },
            ]}
          />
          <div className="chart-legend" aria-hidden="true">
            <span><span className="swatch" style={{ background: 'var(--teal-bar)' }} />Under 100</span>
            <span><span className="swatch" style={{ background: 'var(--accent)' }} />100–499</span>
            <span><span className="swatch" style={{ background: 'var(--amber-bar)' }} />500–999</span>
            <span><span className="swatch" style={{ background: 'var(--series-4)' }} />1000 or more</span>
          </div>
          <MonthDataTable
            summary="View size as a table"
            caption="Median diff size of reviewed pull requests by month"
            months={months}
            columns={[
              { key: 'lines', header: 'Median lines', cells: trends.map((t) => (t.medianChangedLines === null ? '—' : formatInt(t.medianChangedLines))) },
              { key: 'files', header: 'Median files', cells: trends.map((t) => (t.medianChangedFiles === null ? '—' : formatInt(t.medianChangedFiles))) },
              { key: 'sized', header: 'With size', cells: trends.map((t) => formatInt(t.sizedReviewedPrs)), total: formatInt(sized) },
              { key: 'reviewed', header: 'Reviewed', cells: trends.map((t) => formatInt(t.reviewedPrs)), total: formatInt(reviewed) },
            ]}
          />
        </>
      )}
    </section>
  )
}
