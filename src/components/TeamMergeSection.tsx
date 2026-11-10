import { useState } from 'react'
import { DurationChart } from '../charts/DurationChart'
import { DataTable, type DataColumn } from './ChartTable'
import { formatDurationMinutes, formatInt, formatMonthKey, formatWeekLabel, formatWeekTick } from '../data/format'
import {
  durationSeries,
  monthPeriods,
  teamMergeSamples,
  weekPeriods,
  type TimeGrain,
} from '../data/metrics'
import type { TeamMergeSample, WeekEntry } from '../data/types'
import { GrainToggle } from './GrainToggle'

interface TeamMergeSectionProps {
  samples: TeamMergeSample[]
  weeks: WeekEntry[]
  windowMonths: string[]
  rangeEnd: string
  repoFilter: string | null
}

interface MergeRow {
  key: string
  label: string
  count: number
  median: number | null
  p75: number | null
}

const columns: DataColumn<MergeRow>[] = [
  { key: 'n', header: 'Team PRs merged', value: (r) => formatInt(r.count) },
  { key: 'med', header: 'Median', value: (r) => formatDurationMinutes(r.median) },
  { key: 'p75', header: '75th percentile', value: (r) => formatDurationMinutes(r.p75) },
]

/**
 * Creation-to-merge for internal team PRs that merged in the window.
 * Open team PRs are excluded. A team review is not required.
 */
export function TeamMergeSection({ samples, weeks, windowMonths, rangeEnd, repoFilter }: TeamMergeSectionProps) {
  const [grain, setGrain] = useState<TimeGrain>('week')
  const periods = grain === 'week' ? weekPeriods(weeks, windowMonths) : monthPeriods(windowMonths, rangeEnd)
  const series = durationSeries(teamMergeSamples(samples), grain, periods, repoFilter)
  const grainWord = grain === 'week' ? 'week' : 'month'

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
    if (grain === 'month') {
      const full = formatMonthKey(period.key)
      return index === 0 || period.key.endsWith('-01') ? full : full.replace(/ \d{4}$/, '')
    }
    return formatWeekTick(period.start, showYear(index))
  }

  const rows: MergeRow[] = periods.map((period, i) => ({
    key: period.key,
    label:
      grain === 'week'
        ? formatWeekLabel(period.key, period.start, period.partial)
        : `${formatMonthKey(period.key)}${period.partial ? ' (partial)' : ''}`,
    count: series.points[i]?.count ?? 0,
    median: series.points[i]?.medianMinutes ?? null,
    p75: series.points[i]?.p75Minutes ?? null,
  }))

  return (
    <section className="section" aria-labelledby="ttm-title">
      <div className="section__tools">
        <h2 className="section__title" id="ttm-title">
          Time to merge, team PRs
        </h2>
        <GrainToggle grain={grain} onChange={setGrain} label="Time to merge grain" />
      </div>
      <p className="section__desc">
        Elapsed time from creation to merge for internal team pull requests merged in this window.
        Each {grainWord} shows the median of the pull requests merged then. Open team pull requests
        are not included. A team review is not required for a merge to count.
      </p>
      {periods.length === 0 || series.summary.count === 0 ? (
        <p className="section__note">No team pull requests merged in this window.</p>
      ) : (
        <>
          <div className="timing-summary">
            <div className="timing-summary__item">
              <div className="timing-summary__label">Median</div>
              <div className="timing-summary__value">{formatDurationMinutes(series.summary.medianMinutes)}</div>
              <div className="timing-summary__meta">
                75th percentile {formatDurationMinutes(series.summary.p75Minutes)} · {formatInt(series.summary.count)} merged team PRs
              </div>
            </div>
          </div>
          <DurationChart
            points={series.points}
            minGroupPx={grain === 'week' ? 28 : undefined}
            formatTick={(_point, index) => tick(index)}
            ariaLabel={`Time to merge for team pull requests by ${grainWord}. Median ${formatDurationMinutes(series.summary.medianMinutes)} across ${formatInt(series.summary.count)} merged pull requests. 75th percentile ${formatDurationMinutes(series.summary.p75Minutes)}.`}
            series={[
              { key: 'median', label: 'Median time to merge', color: 'var(--accent)', values: series.points.map((p) => p.medianMinutes) },
            ]}
          />
          <div className="chart-legend" aria-hidden="true">
            <span><span className="swatch" style={{ background: 'var(--accent)' }} />Median time to merge</span>
            <span><span className="swatch swatch--hollow" />Partial {grainWord}</span>
          </div>
          <p className="section__note">
            {grain === 'week'
              ? 'Hollow points are partial weeks. Scroll sideways for earlier weeks. '
              : 'The hollow point is the current month, complete only through the data cutoff. '}
            A gap is a {grainWord} with no team merge. The line is the median; the table also lists
            the 75th percentile, which is less swayed by a single long-running pull request than a
            mean would be.
          </p>
          <DataTable
            caption={`Time to merge for internal team pull requests by ${grainWord}`}
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
