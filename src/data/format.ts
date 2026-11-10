/** Formatting helpers. All data semantics are UTC; display is English. */

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

const intFormatter = new Intl.NumberFormat('en-US')

/** "2026-03" -> "Mar 2026" */
export function formatMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split('-')
  const idx = Number(month) - 1
  const name = MONTH_NAMES[idx]
  if (!name) return monthKey
  return `${name} ${year}`
}

/** "2026-03" -> "Mar" (used for dense chart axes) */
export function formatMonthShort(monthKey: string): string {
  const [, month] = monthKey.split('-')
  const idx = Number(month) - 1
  const name = MONTH_NAMES[idx]
  return name ?? monthKey
}

/** "2026-03" -> 3 (1-12), or null if malformed */
export function monthNumber(monthKey: string): number | null {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey)
  if (!match) return null
  const n = Number(match[2])
  return n >= 1 && n <= 12 ? n : null
}

export function isValidMonthKey(monthKey: string): boolean {
  return monthNumber(monthKey) !== null
}

/** "2026-11-07T10:15:00Z" -> "7 Nov 2026, 10:15 UTC" (falls back to raw string) */
export function formatISOTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const day = d.getUTCDate()
  const month = MONTH_NAMES[d.getUTCMonth()]
  const year = d.getUTCFullYear()
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${day} ${month} ${year}, ${hh}:${mm} UTC`
}

/** "2026-11-07T10:15:00Z" -> "7 Nov 2026" */
export function formatISODate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** "2026-11-07T10:15:00Z" -> "2026-11" */
export function monthKeyOfISO(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function formatInt(n: number): string {
  return intFormatter.format(n)
}

// ISO weeks (UTC, Monday 00:00). Keep in lockstep with scripts/lib/config.ts.
const DAY_MS = 86_400_000

/** Monday 00:00:00.000 UTC of the ISO week containing `ms`. */
export function startOfIsoWeekMs(ms: number): number {
  const d = new Date(ms)
  const daysFromMonday = (d.getUTCDay() + 6) % 7
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysFromMonday)
}

/** "YYYY-Www" using the ISO week-year (the year of that week's Thursday). */
export function isoWeekKey(ms: number): string {
  const startMs = startOfIsoWeekMs(ms)
  const year = new Date(startMs + 3 * DAY_MS).getUTCFullYear()
  const week1Start = startOfIsoWeekMs(Date.UTC(year, 0, 4))
  const week = Math.round((startMs - week1Start) / (7 * DAY_MS)) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

export function isoWeekKeyFromIso(iso: string): string | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return isoWeekKey(ms)
}

const WEEK_KEY_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/

export function isValidWeekKey(week: string): boolean {
  return WEEK_KEY_RE.test(week)
}

/** True when `iso` is exactly Monday 00:00:00.000Z. */
export function isMondayMidnightUtc(iso: string): boolean {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return false
  const d = new Date(ms)
  return (
    d.toISOString() === iso &&
    d.getUTCDay() === 1 &&
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  )
}

/**
 * Elapsed minutes as a short duration. Under an hour stays in minutes, under
 * two days in hours, otherwise days, with one decimal when it is needed.
 */
export function formatDurationMinutes(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '—'
  const sign = minutes < 0 ? '-' : ''
  const abs = Math.abs(Math.round(minutes))
  if (abs < 60) return `${sign}${abs}m`
  if (abs < 48 * 60) {
    const hours = Math.round((abs / 60) * 10) / 10
    const text = Number.isInteger(hours) ? String(hours) : hours.toFixed(1)
    return `${sign}${text}h`
  }
  const days = Math.round((abs / 1440) * 10) / 10
  const text = Number.isInteger(days) ? String(days) : days.toFixed(1)
  return `${sign}${text}d`
}

/** "W02 · 5 Jan 2026" and, when partial, a trailing marker. */
export function formatWeekLabel(week: string, weekStart: string, partial = false): string {
  const d = new Date(weekStart)
  if (Number.isNaN(d.getTime())) return partial ? `${week} (partial)` : week
  const text = `${week.slice(5)} · ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  return partial ? `${text} (partial)` : text
}

/** Dense axis label, e.g. "5 Jan" or "5 Jan 2026". */
export function formatWeekTick(weekStart: string, showYear: boolean): string {
  const d = new Date(weekStart)
  if (Number.isNaN(d.getTime())) return weekStart
  const text = `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`
  return showYear ? `${text} ${d.getUTCFullYear()}` : text
}

/** The month is still open when range end falls before the next month starts. */
export function monthExtendsPastRange(month: string, rangeEnd: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) return false
  const nextMonthStart = Date.UTC(Number(match[1]), Number(match[2]), 1)
  const end = Date.parse(rangeEnd)
  return Number.isFinite(end) && end < nextMonthStart
}

/** Hard cap so a corrupt range can never loop the month walk. */
const COVERAGE_WINDOW_MONTHS_CAP = 1200

/**
 * Every month key of the collection window. `range.end` is an EXCLUSIVE
 * instant: its month is included iff any moment of it lies within the range —
 * i.e. unless the end is exactly midnight UTC on the 1st, in which case that
 * month contributes zero days and the window stops with the previous month
 * (…→ 2026-11-01T00:00:00Z ends with Oct 2026, not Nov 2026). A mid-month
 * cutoff (2026-11-07T…) keeps its partial month, per methodology. The
 * coverage panel renders this full window so months with no collected data
 * stay visible instead of being silently dropped; `months[]`/display-window
 * scope the timeline and the month drill-down only.
 *
 * The 1200-month cap is a guard against unbounded rendering on absurd
 * (≥100-year) ranges — corrupt input that validation flags anyway; it cannot
 * trigger for any realistic collection window.
 */
export function coverageWindowMonths(range: { start: string; end: string }): string[] {
  const start = monthKeyOfISO(range.start)
  if (start === null || !isValidMonthKey(start)) return []
  // range.end is EXCLUSIVE: an end that lands exactly on midnight UTC of the
  // 1st contributes zero days of its own month, so the window stops with the
  // previous month (…→ 2026-11-01T00:00:00Z ends with Oct 2026, not Nov 2026).
  const endInstant = new Date(range.end)
  if (Number.isNaN(endInstant.getTime())) return []
  const endOnFirstMidnight =
    endInstant.getUTCDate() === 1 &&
    endInstant.getUTCHours() === 0 &&
    endInstant.getUTCMinutes() === 0 &&
    endInstant.getUTCSeconds() === 0 &&
    endInstant.getUTCMilliseconds() === 0
  const effectiveEnd = new Date(
    endOnFirstMidnight ? endInstant.getTime() - 1 : endInstant.getTime(),
  )
  const end = monthKeyOfISO(effectiveEnd.toISOString())
  if (end === null || !isValidMonthKey(end)) return []
  if (end < start) return []
  const months: string[] = []
  let year = Number(start.slice(0, 4))
  let month = Number(start.slice(5, 7))
  const endYear = Number(end.slice(0, 4))
  const endMonth = Number(end.slice(5, 7))
  while (
    (year < endYear || (year === endYear && month <= endMonth)) &&
    months.length < COVERAGE_WINDOW_MONTHS_CAP
  ) {
    months.push(`${year}-${String(month).padStart(2, '0')}`)
    month += 1
    if (month === 13) {
      month = 1
      year += 1
    }
  }
  return months
}

export function isValidISOTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const d = new Date(value)
  return !Number.isNaN(d.getTime())
}

const REPO_NAMES: Record<string, string> = {
  'MetaMask/core': 'Core',
  'MetaMask/metamask-mobile': 'Mobile',
  'MetaMask/metamask-extension': 'Extension',
  'MetaMask/extension': 'Extension',
}

export function repoDisplayName(repo: string): string {
  return REPO_NAMES[repo] ?? repo
}

export const KNOWN_REPO_ORDER: Record<string, number> = {
  'MetaMask/core': 0,
  'MetaMask/metamask-mobile': 1,
  'MetaMask/metamask-extension': 2,
  'MetaMask/extension': 2,
}

export function compareRepos(a: string, b: string): number {
  const ia = KNOWN_REPO_ORDER[a] ?? Number.MAX_SAFE_INTEGER
  const ib = KNOWN_REPO_ORDER[b] ?? Number.MAX_SAFE_INTEGER
  if (ia !== ib) return ia - ib
  return a.localeCompare(b)
}

/**
 * Public-facing display helpers shared by StateCards, DataNotice and Footer
 * (single source of truth — never render these three differently). State
 * cards can appear on a public URL, so they never show build-host detail:
 * paths are reduced to a repo-relative tail, long errors collapse to one
 * line, and quoted data values inside messages are masked.
 */
export function displayPath(dataPath: string): string {
  const parts = dataPath.split('/')
  return parts.slice(-3).join('/')
}

export function oneLine(text: string, max = 160): string {
  const first = text.split('\n')[0] ?? ''
  return first.length > max ? `${first.slice(0, max)}…` : first
}

/**
 * Mask quoted DATA values in a message. validate.ts quotes offending values
 * with JSON.stringify (double quotes), so long double-quoted spans (arbitrary
 * attacker-ish or data-derived content of any length) collapse to "…" while
 * short quoted tokens (field names like "months", enum words) stay readable.
 * Apostrophes are ordinary prose and never touched. Apply BEFORE oneLine so
 * the 160-char cap can never cut off a closing quote and resurrect raw data.
 */
export function maskQuotedValues(message: string): string {
  return message.replace(/"[^"]*"/g, (m) => (m.length > 18 ? '"…"' : m))
}

/**
 * Caption for the rolling display window. Counts months WITH data and calls
 * out calendar gaps honestly (a month with no months[] row for any repo is a
 * collection gap, not a shorter window). `range` is only consulted when the
 * window itself is empty (structurally-valid data, zero month rows).
 */
export function buildWindowLabel(
  windowMonths: string[],
  range: { start: unknown; end: unknown } | undefined,
  gapCount: number,
): string {
  const monthWord = windowMonths.length === 1 ? 'month' : 'months'
  const gapWord = gapCount === 1 ? 'calendar month' : 'calendar months'
  const gapSuffix = gapCount > 0 ? ` · ${gapCount} ${gapWord} without data in window` : ''
  if (windowMonths.length === 0) {
    const start = typeof range?.start === 'string' ? range.start : ''
    const end = typeof range?.end === 'string' ? range.end : ''
    return `Window: ${formatMonthKey(start)} – ${formatMonthKey(end)} · 0 months with data${gapSuffix}`
  }
  const first = windowMonths[0] ?? ''
  const last = windowMonths[windowMonths.length - 1] ?? ''
  return `Window: ${formatMonthKey(first)} – ${formatMonthKey(last)} · ${windowMonths.length} ${monthWord} with data${gapSuffix}`
}
