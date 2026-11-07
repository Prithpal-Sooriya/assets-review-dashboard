import { GroupedBarChart } from '../charts/GroupedBarChart'
import { ChartTable, type TableColumn } from './ChartTable'
import { formatInt } from '../data/format'
import type { MonthAggregate } from '../data/metrics'

const columns: TableColumn[] = [
  { key: 'unmerged', header: 'Reviewed & unmerged', value: (a) => formatInt(a.reviewedUnmergedPrs), total: (a) => a.reviewedUnmergedPrs },
]

interface UnmergedSectionProps {
  aggregates: MonthAggregate[]
}

export function UnmergedSection({ aggregates }: UnmergedSectionProps) {
  const total = aggregates.reduce((s, a) => s + a.reviewedUnmergedPrs, 0)
  return (
    <section className="section" aria-labelledby="unmerged-title">
      <h2 className="section__title" id="unmerged-title">
        Reviewed and currently unmerged
      </h2>
      <p className="section__desc">
        Pull requests reviewed in each month that were open or closed-without-merge at data
        generation. This is a snapshot of current status, not the historical month-end state.
      </p>
      <GroupedBarChart
        months={aggregates.map((a) => a.month)}
        series={[
          { key: 'unmerged', label: 'Reviewed and currently unmerged PRs', color: 'var(--amber-bar)', values: aggregates.map((a) => a.reviewedUnmergedPrs) },
        ]}
      />
      <div className="chart-legend" aria-hidden="true">
        <span><span className="swatch" style={{ background: 'var(--amber-bar)' }} />Reviewed & unmerged (snapshot)</span>
      </div>
      <p className="section__note">
        {formatInt(total)} reviewed PRs across the window were not merged as of generation. A PR
        reviewed in multiple months appears in each of those months here.
      </p>
      <ChartTable
        caption="Reviewed and currently unmerged pull requests by month (snapshot status)"
        aggregates={aggregates}
        columns={columns}
      />
    </section>
  )
}
