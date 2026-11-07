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
