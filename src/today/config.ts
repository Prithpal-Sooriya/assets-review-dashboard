/**
 * Today view configuration — client-only collection from the GitHub REST API.
 *
 * Everything here is public information: repositories, the team slug, the
 * public GitHub usernames that make up the roster, and collection budgets.
 * No credentials, tokens or private identifiers ever live in this module.
 */

/** The ONLY origin the Today collector may contact (CSP allow-list matches). */
export const GITHUB_API_ORIGIN = 'https://api.github.com'

/**
 * Repositories monitored for review activity. Only these public repos are
 * ever queried — the collector never enumerates accounts or other repos.
 */
export const TODAY_REPOS: readonly string[] = [
  'MetaMask/core',
  'MetaMask/metamask-mobile',
  'MetaMask/metamask-extension',
]

/** GitHub team slug whose review requests mark "Needs Assets review". */
export const ASSETS_TEAM_SLUG = 'metamask-assets'

/**
 * Roster of Assets team member GitHub logins (public usernames), captured
 * 2026-11-07 from the MetaMask org. Authorship attribution ONLY — being on
 * this list says nothing about who should review what.
 *
 * Anonymous requests cannot enumerate team membership, so the roster is a
 * static snapshot and can go stale; a personal access token does NOT refresh
 * it (no account/org queries are ever sent). Roster changes need a config
 * update here.
 */
export const ASSETS_ROSTER: readonly string[] = [
  'amandaye0h',
  'amitabh94',
  'bergarces',
  'dawnseeker8',
  'juanmigdr',
  'Kriys94',
  'Prithpal-Sooriya',
  'sahar-fehri',
  'salimtb',
]

/** Per-page size for pulls listing (GitHub maximum is 100). */
export const PULLS_PER_PAGE = 100

/**
 * Hard ceiling of pages fetched per repo per sweep. Current open-PR counts
 * (2026-11-07: core ~445, mobile ~592, extension ~560 → 5/6/6 pages) leave
 * margin; a repo exceeding this cap is marked truncated, never silently cut.
 */
export const MAX_PAGES_PER_REPO = 8

/** Expected worst-case pages for a full sweep (used for pre-flight budget). */
export const SWEEP_PAGE_ESTIMATE = TODAY_REPOS.length * MAX_PAGES_PER_REPO

/**
 * Total requests one collection cycle may spend (sweep pages + bounded
 * missing-PR state checks). Anonymous budget is 60/hour per shared IP, so
 * the anonymous cap keeps headroom for other users behind the same network.
 */
export const CYCLE_REQUEST_CAP_ANONYMOUS = 30
export const CYCLE_REQUEST_CAP_TOKEN = 60

/**
 * Stop spending requests once `X-RateLimit-Remaining` drops to this floor,
 * so other people/tabs behind the same IP keep quota. Token budget is far
 * larger (5,000+/hour), so its floor only guards against runaway loops.
 */
export const RATE_FLOOR_ANONYMOUS = 10
export const RATE_FLOOR_TOKEN = 100

/** Bounded number of missing PR state checks per cycle (since-yesterday). */
export const MISSING_CHECK_MAX = 20

/** Refresh cadence: a snapshot older than this is stale while the page is open. */
export const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000

/**
 * A snapshot only qualifies as a "since yesterday" baseline once it is at
 * least this old. The actual baseline timestamp is always displayed — the
 * label never invents a "yesterday" that the local cache cannot prove.
 */
export const BASELINE_MIN_AGE_MS = 20 * 60 * 60 * 1000

/**
 * Rotate the baseline to a fresher-but-still-old snapshot when the previous
 * baseline has drifted beyond this age (continuous use would otherwise never
 * rotate). Still labelled with its real timestamp.
 */
export const BASELINE_MAX_AGE_MS = 48 * 60 * 60 * 1000

/** Minimum age for a rotation candidate under the max-age fallback. */
export const BASELINE_ROTATE_MIN_AGE_MS = 12 * 60 * 60 * 1000

/** Two collection cycles are always at least this far apart (storm guard). */
export const MIN_SWEEP_INTERVAL_MS = 5 * 60 * 1000

/** Backoff schedule after a failed cycle (network error / rate limit). */
export const RETRY_BACKOFF_MS: readonly number[] = [5 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000]

/** IndexedDB cache identifiers. Records store public snapshot data only. */
export const CACHE_DB_NAME = 'assets-today-cache'
export const CACHE_DB_VERSION = 1
export const CACHE_STORE = 'snapshots'
export const CACHE_KEY_CURRENT = 'current'
export const CACHE_KEY_BASELINE = 'baseline'
/** Oldest retained complete snapshot within the retention window — the
 * rotation candidate for continuous users (see rollBaseline). */
export const CACHE_KEY_RETAINED = 'retained'

/** Web Locks / BroadcastChannel names for cross-tab coordination. */
export const COLLECT_LOCK_NAME = 'assets-today-collect'
export const CHANNEL_NAME = 'assets-today'
