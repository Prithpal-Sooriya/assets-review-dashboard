import { useMeasure } from '../hooks/useMeasure'
import { DEFAULT_PADDING, barLayout, labelStep, niceMax, niceTicks } from './chartUtils'
import { formatInt, formatMonthShort } from '../data/format'

export interface Series {
  key: string
  label: string
  /** CSS color variable, e.g. 'var(--accent)' */
  color: string
  values: number[]
}

interface GroupedBarChartProps {
  months: string[]
  series: Series[]
  height?: number
  yLabel?: string
  /** Axis tick labels. Defaults to grouped thousands. */
  formatTick?: (value: number) => string
}

/**
 * Side-by-side monthly bars for 1-2 series (merge-vs-review comparisons,
 * unmerged snapshot). Purely presentational — no interaction.
 */
export function GroupedBarChart({ months, series, height = 220, formatTick = formatInt }: GroupedBarChartProps) {
  const [wrapRef, size] = useMeasure<HTMLDivElement>()

  if (size.width <= 0) {
    return <div className="chart-wrap" ref={wrapRef} style={{ height }} aria-hidden="true" />
  }

  const pad = DEFAULT_PADDING
  const layout = barLayout(size.width, height, months.length, pad)
  const max = Math.max(1, ...series.flatMap((s) => s.values))
  const yMax = niceMax(max)
  const ticks = niceTicks(yMax)
  const scale = (v: number) => (v / yMax) * layout.plotHeight
  const n = series.length
  const barWidth = Math.min(22, (layout.groupWidth * 0.72) / n)
  const step = labelStep(layout.groupWidth, 30)

  const totalBySeries = series.map((s) => s.values.reduce((a, b) => a + b, 0))
  const summary = `Grouped bar chart by month: ${series
    .map((s, i) => `${s.label} total ${formatInt(totalBySeries[i]!)}`)
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
                {formatTick(t)}
              </text>
            </g>
          )
        })}
        <line className="axis-line" x1={layout.x0} x2={layout.x0 + layout.plotWidth} y1={layout.y0} y2={layout.y0} />
        {months.map((month, i) => {
          const cx = layout.centres[i]!
          const showLabel = i % step === 0
          return (
            <g key={month}>
              {series.map((s, si) => {
                const v = s.values[i] ?? 0
                if (v <= 0) return null
                const h = scale(v)
                const offset = (si - (n - 1) / 2) * (barWidth + 2)
                return (
                  <rect
                    key={s.key}
                    x={cx + offset - barWidth / 2}
                    y={layout.y0 - h}
                    width={barWidth}
                    height={h}
                    rx={2}
                    fill={s.color}
                  />
                )
              })}
              {showLabel && (
                <text x={cx} y={layout.y0 + 16} textAnchor="middle">
                  {formatMonthShort(month)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
