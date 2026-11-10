import { useEffect } from 'react'
import { useMeasure } from '../hooks/useMeasure'
import { DEFAULT_PADDING, barLayout, labelStep, niceTicks } from './chartUtils'
import { YAxis } from './YAxis'
import { formatDurationMinutes } from '../data/format'
import type { DurationPoint } from '../data/metrics'

export interface DurationSeries {
  key: string
  label: string
  color: string
  /** Minutes, or null when the period has no pull requests. */
  values: (number | null)[]
}

interface DurationChartProps {
  points: DurationPoint[]
  series: DurationSeries[]
  formatTick: (point: DurationPoint, index: number) => string
  ariaLabel: string
  height?: number
  /** When set, the chart scrolls instead of squeezing a long weekly axis. */
  minGroupPx?: number
}

/**
 * Median (or other) durations over a week or month axis. Missing periods
 * break the line rather than being drawn as zero.
 */
export function DurationChart({
  points,
  series,
  formatTick,
  ariaLabel,
  height = 240,
  minGroupPx,
}: DurationChartProps) {
  const [wrapRef, size] = useMeasure<HTMLDivElement>()
  // Latest periods sit on the right, matching the monthly charts. A long
  // weekly axis starts scrolled there so the current weeks are in view.
  useEffect(() => {
    if (!minGroupPx) return
    const el = wrapRef.current
    if (!el) return
    el.scrollLeft = el.scrollWidth
  }, [minGroupPx, size.width, points.length, wrapRef])

  if (size.width <= 0) {
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
  const pad = scrolling ? { ...DEFAULT_PADDING, left: 8 } : { ...DEFAULT_PADDING, left: 48 }
  const svgWidth = scrolling ? Math.max(size.width, points.length * minGroupPx) : size.width
  const layout = barLayout(svgWidth, height, points.length, pad)
  const finite = series.flatMap((s) => s.values.filter((v): v is number => v !== null && v >= 0))
  const axis = durationAxis(Math.max(1, ...finite))
  const ticks = axis.ticks
  const scale = (v: number) => (v / axis.maxMinutes) * layout.plotHeight
  const step = labelStep(layout.groupWidth, minGroupPx ? 52 : 36)

  const segments = (values: (number | null)[]): string[] => {
    const out: string[] = []
    let current: string[] = []
    values.forEach((value, i) => {
      if (value === null) {
        if (current.length > 0) out.push(current.join(' '))
        current = []
        return
      }
      const x = layout.centres[i]!
      const y = layout.y0 - scale(value)
      current.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    })
    if (current.length > 0) out.push(current.join(' '))
    return out
  }

  const plot = (
    <div
      className={scrolling ? 'chart-scroll' : 'chart-wrap'}
      ref={wrapRef}
      tabIndex={scrolling ? 0 : undefined}
      role={scrolling ? 'region' : undefined}
      aria-label={scrolling ? `${ariaLabel} Scroll horizontally for earlier periods.` : undefined}
    >
      <svg
        className="chart"
        height={height}
        width={minGroupPx ? svgWidth : undefined}
        style={minGroupPx ? { width: svgWidth } : undefined}
        role="img"
        aria-label={ariaLabel}
        focusable="false"
      >
        {ticks.map((t) => {
          const y = layout.y0 - scale(t)
          return (
            <g key={t}>
              <line className="gridline" x1={layout.x0} x2={layout.x0 + layout.plotWidth} y1={y} y2={y} />
              {!scrolling && (
                <text x={layout.x0 - 8} y={y + 4} textAnchor="end">
                  {formatAxisTick(t, axis.unit)}
                </text>
              )}
            </g>
          )
        })}
        <line className="axis-line" x1={layout.x0} x2={layout.x0 + layout.plotWidth} y1={layout.y0} y2={layout.y0} />
        {series.map((s) =>
          segments(s.values).map((pointsAttr, i) => (
            <polyline
              key={`${s.key}-${i}`}
              points={pointsAttr}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )),
        )}
        {series.map((s) =>
          s.values.map((value, i) => {
            if (value === null) return null
            const cx = layout.centres[i]!
            const cy = layout.y0 - scale(value)
            const partial = points[i]?.partial
            return (
              <circle
                key={`${s.key}-pt-${i}`}
                cx={cx}
                cy={cy}
                r={partial ? 3.5 : 2.75}
                fill={partial ? 'var(--surface)' : s.color}
                stroke={s.color}
                strokeWidth={partial ? 1.75 : 0}
              >
                <title>
                  {`${formatTick(points[i]!, i)}: ${s.label} ${formatDurationMinutes(value)}${partial ? ' (partial)' : ''}`}
                </title>
              </circle>
            )
          }),
        )}
        {points.map((point, i) => {
          if (i % step !== 0) return null
          return (
            <text key={point.key} x={layout.centres[i]} y={layout.y0 + 16} textAnchor="middle">
              {formatTick(point, i)}
            </text>
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
        format={(tick) => formatAxisTick(tick, axis.unit)}
      />
      {plot}
    </div>
  )
}

type AxisUnit = 'm' | 'h' | 'd'

/**
 * One unit for the whole axis. Ticks are round amounts of that unit, so a
 * chart never labels 0m, then 33.3h, then 2.8d on the same scale.
 */
function durationAxis(maxMinutes: number): { unit: AxisUnit; maxMinutes: number; ticks: number[] } {
  const unit: AxisUnit = maxMinutes < 60 ? 'm' : maxMinutes < 48 * 60 ? 'h' : 'd'
  const perUnit = unit === 'm' ? 1 : unit === 'h' ? 60 : 1440
  const niceUnits = niceIntegerMax(maxMinutes / perUnit)
  const tickUnits = niceTicks(niceUnits)
  return {
    unit,
    maxMinutes: niceUnits * perUnit,
    ticks: tickUnits.map((tick) => tick * perUnit),
  }
}

/** 1/2/5/10 ladder, always a value niceTicks can divide without rounding. */
function niceIntegerMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * base
    if (candidate >= value - 1e-9) return candidate
  }
  return 10 * base
}

function formatAxisTick(minutes: number, unit: AxisUnit): string {
  if (minutes === 0) return '0'
  if (unit === 'm') return `${Math.round(minutes)}m`
  if (unit === 'h') {
    const hours = minutes / 60
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`
  }
  const days = minutes / 1440
  return Number.isInteger(days) ? `${days}d` : `${days.toFixed(1)}d`
}
