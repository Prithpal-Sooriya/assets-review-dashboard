interface YAxisProps {
  height: number
  width?: number
  padTop: number
  padBottom: number
  ticks: number[]
  /** Maps a data value to a pixel height above the baseline. */
  scale: (value: number) => number
  format: (value: number) => string
}

/**
 * Fixed vertical axis drawn beside a horizontally scrolling plot, so the
 * labels stay visible while the weeks move.
 */
export function YAxis({ height, width = 48, padTop, padBottom, ticks, scale, format }: YAxisProps) {
  const y0 = padTop + (height - padTop - padBottom)
  return (
    <svg className="chart-yaxis" width={width} height={height} aria-hidden="true" focusable="false">
      {ticks.map((tick) => (
        <text key={tick} x={width - 8} y={y0 - scale(tick) + 4} textAnchor="end">
          {format(tick)}
        </text>
      ))}
    </svg>
  )
}
