/** Shared SVG chart layout helpers. */

export interface ChartPadding {
  top: number
  right: number
  bottom: number
  left: number
}

export const DEFAULT_PADDING: ChartPadding = { top: 18, right: 14, bottom: 38, left: 52 }

/** Picks a round axis maximum from the 1/2/5 ladder so gridlines read cleanly. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 5
  const exponent = Math.floor(Math.log10(value))
  const base = Math.pow(10, exponent)
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * base
    if (candidate >= value) return candidate
  }
  return 10 * base
}

export function niceTicks(max: number, count = 5): number[] {
  const ticks: number[] = []
  for (let i = 0; i <= count; i++) {
    ticks.push(Math.round((max / count) * i))
  }
  return ticks
}

export interface BarLayout {
  /** x position of the centre of each group */
  centres: number[]
  groupWidth: number
  plotWidth: number
  plotHeight: number
  x0: number
  y0: number
}

export function barLayout(
  width: number,
  height: number,
  count: number,
  padding: ChartPadding = DEFAULT_PADDING,
): BarLayout {
  const plotWidth = Math.max(0, width - padding.left - padding.right)
  const plotHeight = Math.max(0, height - padding.top - padding.bottom)
  const groupWidth = count > 0 ? plotWidth / count : 0
  const centres: number[] = []
  for (let i = 0; i < count; i++) {
    centres.push(padding.left + groupWidth * i + groupWidth / 2)
  }
  return { centres, groupWidth, plotWidth, plotHeight, x0: padding.left, y0: padding.top + plotHeight }
}

/** For dense axes: which x labels to draw (every `step`-th). */
export function labelStep(groupWidth: number, minLabelWidth: number): number {
  if (groupWidth <= 0) return 1
  return Math.max(1, Math.ceil(minLabelWidth / groupWidth))
}
