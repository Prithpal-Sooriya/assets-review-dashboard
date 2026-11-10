import { useEffect } from 'react'
import { useMeasure } from '../hooks/useMeasure'
import { DEFAULT_PADDING, barLayout, labelStep, niceMax, niceTicks } from './chartUtils'
import { YAxis } from './YAxis'
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
  /** Y-axis tick labels. Defaults to grouped thousands. */
  formatYTick?: (value: number) => string
  /** X-axis tick. Defaults to the short month name. */
  formatTick?: (key: string, index: number) => string
  /**
   * Minimum pixels per group. When the groups need more room than the
   * container, the chart scrolls horizontally instead of crushing the labels.
   */
  minGroupPx?: number
  ariaLabel?: string
}

/**
 * Side-by-side monthly bars for 1-2 series (merge-vs-review comparisons,
 * unmerged snapshot). Purely presentational — no interaction.
 */
export function GroupedBarChart({
  months,
  series,
  height = 220,
  formatYTick = formatInt,
  formatTick,
  minGroupPx,
  ariaLabel,
}: GroupedBarChartProps) {
  const [wrapRef, size] = useMeasure<HTMLDivElement>()
  // Latest weeks sit on the right. Start there when the axis scrolls.
  useEffect(() => {
    if (!minGroupPx) return
    const el = wrapRef.current
    if (!el) return
    el.scrollLeft = el.scrollWidth
  }, [minGroupPx, size.width, months.length, wrapRef])

  if (size.width <= 0) {
    // Keep the same DOM shape as the measured chart so the observer stays
    // attached to the scrolling plot, not a placeholder that gets replaced.
    if (!minGroupPx) {
      return <div className="chart-wrap" ref={wrapRef} style={{ height }} aria-hidden="true" />
    }
    return (
      <div className="chart-row" aria-hidden="true">
        <div className="chart-yaxis" style={{ width: 48, height }} />
        <div className="chart-scroll" ref={wrapRef} style={{ height }} />
      </div>
    )
  }

  const scrolling = minGroupPx !== undefined
  const pad = scrolling ? { ...DEFAULT_PADDING, left: 8 } : DEFAULT_PADDING
  const svgWidth = scrolling ? Math.max(size.width, months.length * minGroupPx) : size.width
  const layout = barLayout(svgWidth, height, months.length, pad)
  const max = Math.max(1, ...series.flatMap((s) => s.values))
  const yMax = niceMax(max)
  const ticks = niceTicks(yMax)
  const scale = (v: number) => (v / yMax) * layout.plotHeight
  const n = series.length
  const barWidth = Math.min(22, (layout.groupWidth * 0.72) / n)
  const step = labelStep(layout.groupWidth, 30)

  const totalBySeries = series.map((s) => s.values.reduce((a, b) => a + b, 0))
  const summary = ariaLabel ?? `Grouped bar chart by month: ${series
    .map((s, i) => `${s.label} total ${formatInt(totalBySeries[i]!)}`)
    .join('; ')}.`

  const plot = (
    <div
      className={scrolling ? 'chart-scroll' : 'chart-wrap'}
      ref={wrapRef}
      tabIndex={scrolling ? 0 : undefined}
      role={scrolling ? 'region' : undefined}
      aria-label={scrolling ? `${summary} Scroll horizontally for earlier weeks.` : undefined}
    >
      <svg
        className="chart"
        height={height}
        width={minGroupPx ? svgWidth : undefined}
        style={minGroupPx ? { width: svgWidth } : undefined}
        role="img"
        aria-label={summary}
        focusable="false"
      >
        {ticks.map((t) => {
          const y = layout.y0 - scale(t)
          return (
            <g key={t}>
              <line className="gridline" x1={layout.x0} x2={layout.x0 + layout.plotWidth} y1={y} y2={y} />
              {!scrolling && (
                <text x={layout.x0 - 8} y={y + 4} textAnchor="end">
                  {formatYTick(t)}
                </text>
              )}
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
                  {formatTick ? formatTick(month, i) : formatMonthShort(month)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )

  if (!scrolling) return plot
  return (
    <div className="chart-row">
      <YAxis
        height={height}
        padTop={pad.top}
        padBottom={pad.bottom}
        ticks={ticks}
        scale={scale}
        format={(tick) => formatYTick(tick)}
      />
      {plot}
    </div>
  )
}
