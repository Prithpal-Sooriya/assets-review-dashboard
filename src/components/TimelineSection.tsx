import { StackedBarChart } from '../charts/StackedBarChart'
import { ChartTable, type TableColumn } from './ChartTable'
import { formatInt } from '../data/format'
import type { MonthAggregate } from '../data/metrics'

interface TimelineSectionProps {
  aggregates: MonthAggregate[]
  selectedMonth: string | null
  onSelectMonth: (month: string) => void
  partialMonths: Set<string>
}

const columns: TableColumn[] = [
  { key: 'internal', header: 'Internal reviewed', value: (a) => formatInt(a.internalReviewedPrs), total: (a) => a.internalReviewedPrs },
  { key: 'external', header: 'External reviewed', value: (a) => formatInt(a.externalReviewedPrs), total: (a) => a.externalReviewedPrs },
  { key: 'submissions', header: 'Review submissions', value: (a) => formatInt(a.reviewSubmissions), total: (a) => a.reviewSubmissions },
  { key: 'unmerged', header: 'Reviewed & unmerged', value: (a) => formatInt(a.reviewedUnmergedPrs), total: (a) => a.reviewedUnmergedPrs },
]

export function TimelineSection({ aggregates, selectedMonth, onSelectMonth, partialMonths }: TimelineSectionProps) {
  const partialCount = aggregates.filter((a) => partialMonths.has(a.month)).length
  return (
    <section className="section" aria-labelledby="timeline-title">
      <h2 className="section__title" id="timeline-title">
        Reviewed PRs per month
      </h2>
      <p className="section__desc">
        Unique pull requests with at least one qualifying team review in the month, split by
        ownership. A PR reviewed in two months counts once in each month; reviews are deduped
        per PR per month. Select a month (click or keyboard) to drill down.
      </p>
      <StackedBarChart
        aggregates={aggregates}
        selectedMonth={selectedMonth}
        onSelectMonth={onSelectMonth}
        partialMonths={partialMonths}
      />
      <div className="chart-legend" aria-hidden="true">
        <span><span className="swatch" style={{ background: 'var(--accent)' }} />Internal (team-owned)</span>
        <span><span className="swatch" style={{ background: 'var(--teal-bar)' }} />External</span>
        <span><span className="swatch swatch--hatch" />Partial month (captured through cutoff)</span>
      </div>
      <p className="section__note">
        {partialCount > 0
          ? `${partialCount} month${partialCount === 1 ? ' is' : 's are'} incomplete for at least one repository (hatched); counts there may understate activity. `
          : ''}
        Monthly counts include reviews on PRs that are still open or were closed without merge.
      </p>
      <ChartTable
        caption="Reviewed pull requests, review submissions and unmerged snapshot by month"
        aggregates={aggregates}
        columns={columns}
      />
    </section>
  )
}
