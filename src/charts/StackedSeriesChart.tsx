import { useMeasure } from '../hooks/useMeasure'
import { DEFAULT_PADDING, barLayout, labelStep, niceMax, niceTicks } from './chartUtils'
import { formatInt, formatMonthKey, formatMonthShort } from '../data/format'
import type { Series } from './GroupedBarChart'

interface StackedSeriesChartProps {
  months: string[]
  series: Series[]
  height?: number
  /** Accessible name. A generated total is used when omitted. */
  label?: string
}

/**
 * Monthly stacked bars for more than two series (who reviewed, review
 * outcomes, pull-request size). Presentational: the table under the chart
 * carries the same numbers.
 */
export function StackedSeriesChart({ months, series, height = 260, label }: StackedSeriesChartProps) {
  const [wrapRef, size] = useMeasure<HTMLDivElement>()

  if (size.width <= 0) {
    return <div className="chart-wrap" ref={wrapRef} style={{ height }} aria-hidden="true" />
  }

  const pad = DEFAULT_PADDING
  const layout = barLayout(size.width, height, months.length, pad)
  const totals = months.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0))
  const yMax = niceMax(Math.max(1, ...totals))
  const ticks = niceTicks(yMax)
  const scale = (v: number) => (v / yMax) * layout.plotHeight
  const barWidth = Math.min(34, layout.groupWidth * 0.64)
  const step = labelStep(layout.groupWidth, 30)
  const summary =
    label ??
    `Stacked bar chart by month: ${series
      .map((s) => `${s.label} total ${formatInt(s.values.reduce((a, b) => a + b, 0))}`)
      .join('; ')}.`

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg className="chart" height={height} role="img" aria-label={summary} focusable="false">
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
        {months.map((month, i) => {
          const cx = layout.centres[i]!
          const showLabel = i % step === 0
          let stacked = 0
          return (
            <g key={month}>
              {series.map((s) => {
                const v = s.values[i] ?? 0
                if (v <= 0) return null
                const h = scale(v)
                const y = layout.y0 - stacked - h
                stacked += h
                return (
                  <rect
                    key={s.key}
                    x={cx - barWidth / 2}
                    y={y}
                    width={barWidth}
                    height={h}
                    rx={2}
                    fill={s.color}
                  />
                )
              })}
              {showLabel && (
                <text x={cx} y={layout.y0 + 16} textAnchor="middle">
                  {month.endsWith('-01') ? formatMonthKey(month) : formatMonthShort(month)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
