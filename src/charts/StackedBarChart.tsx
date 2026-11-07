import { useId } from 'react'
import { useMeasure } from '../hooks/useMeasure'
import { DEFAULT_PADDING, barLayout, labelStep, niceMax, niceTicks } from './chartUtils'
import { formatInt, formatMonthKey, formatMonthShort } from '../data/format'
import type { MonthAggregate } from '../data/metrics'

interface StackedBarChartProps {
  aggregates: MonthAggregate[]
  selectedMonth: string | null
  onSelectMonth: (month: string) => void
  partialMonths: Set<string>
  height?: number
}

/**
 * Main timeline: reviewed PRs per month, stacked internal (accent) over
 * external (teal). Each month group is a focusable button that drives the
 * drill-down panel. Partial months are hatched.
 */
export function StackedBarChart({
  aggregates,
  selectedMonth,
  onSelectMonth,
  partialMonths,
  height = 300,
}: StackedBarChartProps) {
  const [wrapRef, size] = useMeasure<HTMLDivElement>()
  const hatchId = useId()
  const width = size.width

  if (width <= 0) {
    return <div className="chart-wrap" ref={wrapRef} style={{ height }} aria-hidden="true" />
  }

  const pad = DEFAULT_PADDING
  const layout = barLayout(width, height, aggregates.length, pad)
  const maxTotal = Math.max(
    1,
    ...aggregates.map((a) => a.internalReviewedPrs + a.externalReviewedPrs),
  )
  const yMax = niceMax(maxTotal)
  const ticks = niceTicks(yMax)
  const scale = (v: number) => (v / yMax) * layout.plotHeight
  const barWidth = Math.min(34, layout.groupWidth * 0.64)
  const step = labelStep(layout.groupWidth, 30)
  const totalReviewed = aggregates.reduce((s, a) => s + a.internalReviewedPrs + a.externalReviewedPrs, 0)
  const peak = aggregates.reduce((m, a) => Math.max(m, a.internalReviewedPrs + a.externalReviewedPrs), 0)
  const peakLabel = peak > 0 ? formatMonthKey(aggregates.find((a) => a.internalReviewedPrs + a.externalReviewedPrs === peak)!.month) : ''

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <p className="hidden-visually">
        Stacked bar chart of reviewed pull requests per month: {totalReviewed} PRs reviewed
        across {aggregates.length} months, peak {peak} in {peakLabel}. Each month bar is a
        button that opens the month details panel.
      </p>
      <svg
        className="chart"
        height={height}
        role="group"
        aria-label="Reviewed PRs per month, stacked by internal and external ownership"
        focusable="false"
      >
        <defs>
          <pattern id={hatchId} width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="7" height="7" fill="transparent" />
            <line x1="0" y1="0" x2="0" y2="7" stroke="var(--text-faint)" strokeWidth="1.6" opacity="0.4" />
          </pattern>
        </defs>
        {ticks.map((t) => {
          const y = layout.y0 - scale(t)
          return (
            <g key={t}>
              <line className="gridline" x1={layout.x0} x2={layout.x0 + layout.plotWidth} y1={y} y2={y} />
              <text x={layout.x0 - 8} y={y + 4} textAnchor="end">
                {formatInt(t)}
              </text>
            </g>
          )
        })}
        <line className="axis-line" x1={layout.x0} x2={layout.x0 + layout.plotWidth} y1={layout.y0} y2={layout.y0} />
        {aggregates.map((a, i) => {
          const cx = layout.centres[i]!
          const selected = a.month === selectedMonth
          const partial = partialMonths.has(a.month)
          const hInternal = scale(a.internalReviewedPrs)
          const hExternal = scale(a.externalReviewedPrs)
          const showLabel = i % step === 0
          const isJanuary = a.month.endsWith('-01')
          const label = isJanuary ? formatMonthKey(a.month) : formatMonthShort(a.month)
          const labelFull = formatMonthKey(a.month)
          const aria = [
            `${labelFull}:`,
            `${a.internalReviewedPrs} internal and ${a.externalReviewedPrs} external reviewed PRs,`,
            `${a.reviewSubmissions} review submissions,`,
            `${a.reviewedUnmergedPrs} reviewed and currently unmerged.`,
            partial ? 'Partial month (data captured through cutoff).' : '',
            selected ? 'Currently selected.' : 'Press to view month details.',
          ].join(' ')
          return (
            <g
              key={a.month}
              className="bar-group"
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={aria}
              onClick={() => onSelectMonth(a.month)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelectMonth(a.month)
                }
              }}
            >
              <rect
                className="hit"
                x={cx - layout.groupWidth / 2 + 1}
                y={pad.top}
                width={Math.max(0, layout.groupWidth - 2)}
                height={layout.plotHeight}
                rx={4}
              />
              {a.internalReviewedPrs > 0 && (
                <rect
                  x={cx - barWidth / 2}
                  y={layout.y0 - hInternal}
                  width={barWidth}
                  height={hInternal}
                  rx={2}
                  fill="var(--accent)"
                />
              )}
              {a.externalReviewedPrs > 0 && (
                <rect
                  x={cx - barWidth / 2}
                  y={layout.y0 - hInternal - hExternal}
                  width={barWidth}
                  height={hExternal}
                  rx={2}
                  fill="var(--teal-bar)"
                />
              )}
              {partial && (
                <rect
                  x={cx - barWidth / 2}
                  y={pad.top}
                  width={barWidth}
                  height={layout.plotHeight}
                  fill={`url(#${hatchId})`}
                  pointerEvents="none"
                />
              )}
              {showLabel && (
                <text x={cx} y={layout.y0 + 16} textAnchor="middle">
                  {label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
