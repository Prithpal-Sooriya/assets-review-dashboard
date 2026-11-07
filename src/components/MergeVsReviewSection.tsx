import { GroupedBarChart } from '../charts/GroupedBarChart'
import { ChartTable, type TableColumn } from './ChartTable'
import { formatInt } from '../data/format'
import type { MonthAggregate } from '../data/metrics'

interface MergeVsReviewSectionProps {
  aggregates: MonthAggregate[]
}

const columns: TableColumn[] = [
  { key: 'ir', header: 'Internal reviewed', value: (a) => formatInt(a.internalReviewedPrs), total: (a) => a.internalReviewedPrs },
  { key: 'mi', header: 'Merged internal', value: (a) => formatInt(a.mergedInternalPrs), total: (a) => a.mergedInternalPrs },
  { key: 'er', header: 'External reviewed', value: (a) => formatInt(a.externalReviewedPrs), total: (a) => a.externalReviewedPrs },
  { key: 'me', header: 'Merged external (reviewed)', value: (a) => formatInt(a.mergedExternalReviewedPrs), total: (a) => a.mergedExternalReviewedPrs },
]

/**
 * Explicit merge-vs-review comparison. The two directions have different
 * semantics, so they are shown as separate charts with their own captions
 * rather than implying a single conversion rate.
 */
export function MergeVsReviewSection({ aggregates }: MergeVsReviewSectionProps) {
  const months = aggregates.map((a) => a.month)
  return (
    <section className="section" aria-labelledby="mvr-title">
      <h2 className="section__title" id="mvr-title">
        Merge throughput vs review coverage
      </h2>
      <p className="section__desc">
        Reviewed counts and merged counts measure different things and are shown side by side
        rather than as a conversion rate.
      </p>
      <div className="chart-grid">
        <div>
          <h3 className="section__title" style={{ fontSize: 14 }}>
            Internal: reviewed vs merged
          </h3>
          <p className="section__note" style={{ margin: '2px 0 0' }}>
            Internal merges are team throughput and do not require a team review; the reviewed
            series only counts internal PRs that received one.
          </p>
          <GroupedBarChart
            months={months}
            series={[
              { key: 'internalReviewed', label: 'Internal PRs reviewed', color: 'var(--accent)', values: aggregates.map((a) => a.internalReviewedPrs) },
              { key: 'mergedInternal', label: 'Internal PRs merged', color: 'var(--neutral-bar)', values: aggregates.map((a) => a.mergedInternalPrs) },
            ]}
          />
          <div className="chart-legend" aria-hidden="true">
            <span><span className="swatch" style={{ background: 'var(--accent)' }} />Reviewed</span>
            <span><span className="swatch" style={{ background: 'var(--neutral-bar)' }} />Merged</span>
          </div>
        </div>
        <div>
          <h3 className="section__title" style={{ fontSize: 14 }}>
            External: reviewed vs merged
          </h3>
          <p className="section__note" style={{ margin: '2px 0 0' }}>
            External merges counted here had a qualifying team review at or before merge; other
            external merges are out of scope for this dashboard.
          </p>
          <GroupedBarChart
            months={months}
            series={[
              { key: 'externalReviewed', label: 'External PRs reviewed', color: 'var(--teal-bar)', values: aggregates.map((a) => a.externalReviewedPrs) },
              { key: 'mergedExternalReviewed', label: 'External reviewed PRs merged', color: 'var(--neutral-bar)', values: aggregates.map((a) => a.mergedExternalReviewedPrs) },
            ]}
          />
          <div className="chart-legend" aria-hidden="true">
            <span><span className="swatch" style={{ background: 'var(--teal-bar)' }} />Reviewed</span>
            <span><span className="swatch" style={{ background: 'var(--neutral-bar)' }} />Merged with team review</span>
          </div>
        </div>
      </div>
      <ChartTable
        caption="Internal and external reviewed and merged pull request counts by month"
        aggregates={aggregates}
        columns={columns}
      />
    </section>
  )
}
