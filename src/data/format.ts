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
