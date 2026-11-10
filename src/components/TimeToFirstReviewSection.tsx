import { useState } from 'react'
import { DurationChart } from '../charts/DurationChart'
import { DataTable, type DataColumn } from './ChartTable'
import { formatDurationMinutes, formatInt, formatMonthKey, formatWeekLabel, formatWeekTick } from '../data/format'
import {
  durationSeries,
  firstReviewSamples,
  monthPeriods,
  weekPeriods,
  type DurationSummary,
  type TimeGrain,
} from '../data/metrics'
import type { FirstReviewSample, WeekEntry } from '../data/types'
import { GrainToggle } from './GrainToggle'

interface TimeToFirstReviewSectionProps {
  samples: FirstReviewSample[]
  weeks: WeekEntry[]
  windowMonths: string[]
  rangeEnd: string
  repoFilter: string | null
}

interface TimingRow {
  key: string
  label: string
  internalCount: number
  internalMedian: number | null
  internalP75: number | null
  externalCount: number
  externalMedian: number | null
  externalP75: number | null
}

const columns: DataColumn<TimingRow>[] = [
  { key: 'ic', header: 'Internal PRs', value: (r) => formatInt(r.internalCount) },
  { key: 'im', header: 'Internal median', value: (r) => formatDurationMinutes(r.internalMedian) },
  { key: 'ip', header: 'Internal 75th', value: (r) => formatDurationMinutes(r.internalP75) },
  { key: 'ec', header: 'External PRs', value: (r) => formatInt(r.externalCount) },
  { key: 'em', header: 'External median', value: (r) => formatDurationMinutes(r.externalMedian) },
  { key: 'ep', header: 'External 75th', value: (r) => formatDurationMinutes(r.externalP75) },
]

function SummaryFigure({ label, summary }: { label: string; summary: DurationSummary }) {
  return (
    <div className="timing-summary__item">
      <div className="timing-summary__label">{label}</div>
      <div className="timing-summary__value">{formatDurationMinutes(summary.medianMinutes)}</div>
      <div className="timing-summary__meta">
        median · 75th {formatDurationMinutes(summary.p75Minutes)} · {formatInt(summary.count)} PRs
      </div>
    </div>
  )
}

/**
 * Time from PR creation to the first qualifying team review, for reviews
 * that happened in the window. Open PRs the team has not reviewed are excluded.
 */
export function TimeToFirstReviewSection({
  samples,
  weeks,
  windowMonths,
  rangeEnd,
  repoFilter,
}: TimeToFirstReviewSectionProps) {
  const [grain, setGrain] = useState<TimeGrain>('week')
  const periods = grain === 'week' ? weekPeriods(weeks, windowMonths) : monthPeriods(windowMonths, rangeEnd)
  const internalSamples = firstReviewSamples(samples.filter((s) => s.ownership === 'internal'))
  const externalSamples = firstReviewSamples(samples.filter((s) => s.ownership === 'external'))
  const internal = durationSeries(internalSamples, grain, periods, repoFilter)
  const external = durationSeries(externalSamples, grain, periods, repoFilter)
  const grainWord = grain === 'week' ? 'week' : 'month'
  const any = internal.summary.count + external.summary.count > 0

  const showYear = (index: number): boolean => {
    const start = periods[index]?.start
    if (!start) return false
    if (index === 0) return true
    const prev = periods[index - 1]?.start
    return !prev || new Date(prev).getUTCFullYear() !== new Date(start).getUTCFullYear()
  }
  const tick = (index: number): string => {
    const period = periods[index]
    if (!period) return ''
    if (grain === 'month') return formatMonthTick(period.key, index)
    return formatWeekTick(period.start, showYear(index))
  }

  const rows: TimingRow[] = periods.map((period, i) => ({
    key: period.key,
    label:
      grain === 'week'
        ? formatWeekLabel(period.key, period.start, period.partial)
        : `${formatMonthKey(period.key)}${period.partial ? ' (partial)' : ''}`,
    internalCount: internal.points[i]?.count ?? 0,
    internalMedian: internal.points[i]?.medianMinutes ?? null,
    internalP75: internal.points[i]?.p75Minutes ?? null,
    externalCount: external.points[i]?.count ?? 0,
    externalMedian: external.points[i]?.medianMinutes ?? null,
    externalP75: external.points[i]?.p75Minutes ?? null,
  }))

  return (
    <section className="section" aria-labelledby="tfr-title">
      <div className="section__tools">
        <h2 className="section__title" id="tfr-title">
          Time to first review
        </h2>
        <GrainToggle grain={grain} onChange={setGrain} label="Time to first review grain" />
      </div>
      <p className="section__desc">
        Elapsed time from pull request creation to the earliest qualifying team review, for
        reviews inside this window. Each {grainWord} shows the median wait of the pull requests
        first reviewed then. Pull requests the team has not reviewed are excluded, so this is the
        wait among reviews that happened. The 75th percentile is in the table.
      </p>
      {periods.length === 0 || !any ? (
        <p className="section__note">No qualifying team reviews in this window.</p>
      ) : (
        <>
          <div className="timing-summary">
            <SummaryFigure label="Internal" summary={internal.summary} />
            <SummaryFigure label="External" summary={external.summary} />
          </div>
          <DurationChart
            points={internal.points}
            minGroupPx={grain === 'week' ? 28 : undefined}
            formatTick={(_point, index) => tick(index)}
            ariaLabel={`Time to first review by ${grainWord}. Internal median ${formatDurationMinutes(internal.summary.medianMinutes)} across ${formatInt(internal.summary.count)} pull requests. External median ${formatDurationMinutes(external.summary.medianMinutes)} across ${formatInt(external.summary.count)} pull requests.`}
            series={[
              { key: 'internal', label: 'Internal median', color: 'var(--accent)', values: internal.points.map((p) => p.medianMinutes) },
              { key: 'external', label: 'External median', color: 'var(--teal-bar)', values: external.points.map((p) => p.medianMinutes) },
            ]}
          />
          <div className="chart-legend" aria-hidden="true">
            <span><span className="swatch" style={{ background: 'var(--accent)' }} />Internal median</span>
            <span><span className="swatch" style={{ background: 'var(--teal-bar)' }} />External median</span>
            <span><span className="swatch swatch--hollow" />Partial {grainWord}</span>
          </div>
          <p className="section__note">
            {grain === 'week'
              ? 'Hollow points are partial weeks: clipped by the window start or the data cutoff, or overlapping a month that was not fully collected. Scroll sideways for earlier weeks.'
              : 'The hollow point is the current month, complete only through the data cutoff.'}{' '}
            A gap is a {grainWord} with no first review. Self-reviews do not start the clock.
          </p>
          <DataTable
            caption={`Time to first qualifying team review by ${grainWord}`}
            rows={rows}
            columns={columns}
            rowHeader={grain === 'week' ? 'Week' : 'Month'}
            label={(row) => row.label}
          />
        </>
      )}
    </section>
  )
}

function formatMonthTick(month: string, index: number): string {
  const full = formatMonthKey(month)
  if (index === 0 || month.endsWith('-01')) return full
  return full.replace(/ \d{4}$/, '')
}
