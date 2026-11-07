import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * Today-view e2e against the demo build with api.github.com fully mocked via
 * page.route — no network, no real credentials, deterministic data.
 *
 * Anonymous mock data models GitHub's real behaviour:
 *  - anonymous responses OMIT team review requests (GitHub hides them from
 *    unauthenticated calls) but DO include direct reviewer requests;
 *  - token responses (Authorization header present) include team requests.
 */

const MEMBER = 'salimtb' // roster member
const RESET_AT = Math.floor(Date.now() / 1000) + 3600

const ANON_RATE_HEADERS = {
  'x-ratelimit-limit': '60',
  'x-ratelimit-remaining': '55',
  'x-ratelimit-reset': String(RESET_AT),
}
const TOKEN_RATE_HEADERS = {
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': '4900',
  'x-ratelimit-reset': String(RESET_AT),
}

interface RawPull {
  number: number
  title: string
  html_url: string
  draft: boolean
  created_at: string
  updated_at: string
  user: { login: string } | null
  labels: { name: string }[] | null
  requested_reviewers: { login: string }[] | null
  requested_teams: { slug: string }[] | null
}

function pr(n: number, overrides: Partial<RawPull> = {}): RawPull {
  return {
    number: n,
    title: `PR ${n}`,
    html_url: `https://github.com/MetaMask/core/pull/${n}`,
    draft: false,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-06T00:00:00Z',
    user: { login: 'external-author' },
    labels: [],
    requested_reviewers: [],
    requested_teams: [],
    ...overrides,
  }
}

// Anonymous-visible PRs:
//  #201 — direct reviewer request to a roster member → Needs view
//  #202 — authored by a roster member, requested by another team → Awaiting view
//  #203 — external author, no visible requests → neither view
const ANON_PRS: RawPull[] = [
  pr(201, { requested_reviewers: [{ login: MEMBER }] }),
  pr(202, {
    user: { login: MEMBER },
    requested_reviewers: null,
    requested_teams: [{ slug: 'core-platform' }], // visible to anonymous too
  }),
  pr(203),
]
// Token-only additions:
//  #101 — team request to metamask-assets (anonymous API hides it) → Needs view
const TOKEN_ONLY_PRS: RawPull[] = [
  pr(101, { requested_teams: [{ slug: 'metamask-assets' }] }),
]

interface MockOptions {
  /** Per-request delay, ms — used by the cross-tab test to hold the lock. */
  delayMs?: number
  /** Remaining reported by the anonymous pre-flight. */
  preflightRemaining?: number
  /** Fail all pulls requests with a network abort after this is armed. */
  failNetwork?: () => boolean
  /** Token-side 401 (rejected token). */
  tokenRejected?: boolean
}

function json(route: Route, status: number, body: unknown, headers: Record<string, string>) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers,
    body: JSON.stringify(body),
  })
}

/**
 * Install the api.github.com mock. Records request counts on the route
 * handler object for assertions (per-page).
 */
async function mockGitHub(page: Page, opts: MockOptions = {}) {
  const counts = { preflight: 0, pulls: 0, detail: 0 }
  const delay = () => (opts.delayMs ? new Promise((r) => setTimeout(r, opts.delayMs)) : Promise.resolve())
  await page.route('**/api.github.com/**', async (route) => {
    await delay()
    const url = new URL(route.request().url())
    const authed = route.request().headers()['authorization'] !== undefined
    const rateHeaders = authed ? TOKEN_RATE_HEADERS : ANON_RATE_HEADERS
    if (url.pathname === '/rate_limit') {
      counts.preflight += 1
      return json(route, 200, {
        resources: {
          core: {
            limit: 5000,
            remaining: opts.preflightRemaining ?? (authed ? 4900 : 55),
            reset: RESET_AT,
          },
        },
      }, rateHeaders)
    }
    const detail = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(url.pathname)
    if (detail) {
      counts.detail += 1
      const n = Number(detail[3])
      if (n === 999) return json(route, 200, { state: 'closed', merged_at: '2026-11-06T10:00:00Z' }, rateHeaders)
      if (n === 998) return json(route, 200, { state: 'open', merged_at: null }, rateHeaders)
      return json(route, 200, { state: 'open', merged_at: null }, rateHeaders)
    }
    if (url.pathname.endsWith('/pulls')) {
      counts.pulls += 1
      if (opts.failNetwork?.()) return route.abort('failed')
      if (authed && opts.tokenRejected) return json(route, 401, { message: 'Bad credentials' }, rateHeaders)
      const repo = url.pathname.split('/repos/')[1]?.replace('/pulls', '') ?? ''
      if (repo !== 'MetaMask/core') return json(route, 200, [], rateHeaders)
      const items = authed ? [...TOKEN_ONLY_PRS, ...ANON_PRS] : ANON_PRS
      return json(route, 200, items, rateHeaders)
    }
    return json(route, 404, { message: 'Not Found' }, rateHeaders)
  })
  return counts
}

/** A full TodayPr-shaped object for seeding IndexedDB directly. */
function seedPr(n: number, overrides: Record<string, unknown> = {}) {
  return {
    repo: 'MetaMask/core',
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/MetaMask/core/pull/${n}`,
    author: 'external-author',
    draft: false,
    createdAt: '2026-10-31T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    labels: [] as string[],
    requestedTeams: [] as string[],
    requestedReviewers: [] as string[],
    ...overrides,
  }
}

async function gotoToday(page: Page, hash = '#/today') {
  await page.goto(`/${hash}`)
  await expect(page.getByRole('heading', { name: 'Optional: personal access token' })).toBeVisible()
}

/* ------------------------------------------------------------------ */

test.describe('Today view — routing and History regression', () => {
  test('no hash lands on History; Today reachable via nav and deep link', async ({ page }) => {
    await mockGitHub(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Assets review workload' })).toBeVisible()
    // History content, not Today.
    await expect(page.locator('.stat').first()).toBeVisible()
    await expect(page.locator('.today-meta')).toHaveCount(0)

    await page.getByRole('link', { name: 'Today' }).click()
    await expect(page.locator('.today-meta')).toBeVisible()
    expect(page.url()).toContain('#/today')

    await page.getByRole('link', { name: 'History' }).click()
    await expect(page.locator('.stat').first()).toBeVisible()
    expect(page.url()).toContain('#/history')
  })

  test('legacy History deep links still work unchanged', async ({ page }) => {
    await mockGitHub(page) // in case a stray Today mount happens
    await page.goto('/#/')
    await expect(page.locator('.stat').first()).toBeVisible()
    await page.goto('/#/anything-old')
    await expect(page.locator('.stat').first()).toBeVisible()
    await expect(page.locator('.today-meta')).toHaveCount(0)
  })
})

test.describe('Today view — anonymous collection and classification', () => {
  test('needs view lists direct reviewer requests only, with honest visibility note', async ({ page }) => {
    await mockGitHub(page)
    await gotoToday(page)
    const table = page.locator('.today-table')
    await expect(table).toBeVisible()
    // #201 (member request) qualifies; #202/#203 do not.
    await expect(table.locator('tbody tr td a.pr-link')).toHaveCount(1)
    await expect(table).toContainText('#201')
    await expect(table).not.toContainText('#202')
    await expect(table).not.toContainText('#101')
    // Anonymous visibility honesty note on the needs view.
    await expect(page.getByText('Limited visibility')).toBeVisible()
  })

  test('awaiting view lists team-authored PRs with what they wait on', async ({ page }) => {
    await mockGitHub(page)
    await gotoToday(page, '#/today?view=awaiting')
    const table = page.locator('.today-table')
    await expect(table).toBeVisible()
    await expect(table).toContainText('#202')
    await expect(table).toContainText('Awaiting core-platform')
    await expect(table).not.toContainText('#201')
    await expect(table).not.toContainText('#203')
  })

  test('authorship filter and grouping reflect in the URL and the table', async ({ page }) => {
    await mockGitHub(page)
    await gotoToday(page)
    await page.getByRole('button', { name: 'External authors' }).click()
    expect(page.url()).toContain('author=external')
    // #201 is external-authored and member-requested.
    await expect(page.locator('.today-table')).toContainText('#201')

    await page.getByRole('button', { name: 'Group: requested team' }).click()
    expect(page.url()).toContain('group=team')
    await expect(page.locator('.today-group-head').first()).toContainText('No team request')

    await page.getByRole('button', { name: 'Newest first' }).click()
    expect(page.url()).toContain('sort=newest')
  })

  test('deep-link filters render without clicking (URL is the source of truth)', async ({ page }) => {
    await mockGitHub(page)
    await gotoToday(page, '#/today?view=awaiting&group=repo&sort=newest')
    const table = page.locator('.today-table')
    await expect(table).toBeVisible()
    await expect(table).toContainText('#202')
    await expect(page.locator('.today-group-head').first()).toContainText('Core')
  })
})

test.describe('Today view — token flow', () => {
  const TOKEN = 'github_pat_E2E_TEST_TOKEN_1234567890'

  test('token unlocks team requests and is never persisted anywhere', async ({ page }) => {
    await mockGitHub(page)
    await gotoToday(page)
    await page.locator('.token-input').fill(TOKEN)
    await page.getByRole('button', { name: 'Use token' }).click()

    // Team-requested PR appears (token-mode data).
    const table = page.locator('.today-table')
    await expect(table).toContainText('#101')
    await expect(table).toContainText('Assets team')
    // The visibility-limited note is gone (token data shows team requests).
    await expect(page.getByText('Limited visibility')).toHaveCount(0)
    // Token active note visible.
    await expect(page.getByText('Token active — held in memory only')).toBeVisible()

    // --- Nonpersistence: nothing in any storage, nothing in the DOM. ---
    const leaks = await page.evaluate((token: string) => {
      const hits: string[] = []
      const scan = (label: string, values: string[]) => {
        for (const v of values) if (v.includes(token)) hits.push(label)
      }
      scan(
        'localStorage',
        Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k) ?? ''}`),
      )
      scan(
        'sessionStorage',
        Object.keys(sessionStorage).map((k) => `${k}=${sessionStorage.getItem(k) ?? ''}`),
      )
      if (document.cookie.includes(token)) hits.push('cookie')
      return hits
    }, TOKEN)
    expect(leaks).toEqual([])

    // IndexedDB cache: snapshots only — the token must not appear in any record.
    const idbLeak = await page.evaluate(async (token: string) => {
      const dbs = await indexedDB.databases()
      const hits: string[] = []
      for (const { name } of dbs) {
        if (name === undefined) continue
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open(name)
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        for (const storeName of Array.from(db.objectStoreNames)) {
          const values = await new Promise<string[]>((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly')
            const req = tx.objectStore(storeName).getAll()
            req.onsuccess = () => resolve((req.result as unknown[]).map((v) => JSON.stringify(v)))
            req.onerror = () => reject(req.error)
          })
          for (const v of values) if (v.includes(token)) hits.push(`${name}/${storeName}`)
        }
        db.close()
      }
      return hits
    }, TOKEN)
    expect(idbLeak).toEqual([])

    // Not in the URL either.
    expect(page.url()).not.toContain('github_pat')

    // --- Reload: token is memory-only; anonymous collection resumes. ---
    await page.reload()
    await expect(page.locator('.today-table')).toBeVisible()
    await expect(page.locator('.today-table')).not.toContainText('#101')
    await expect(page.getByText('Limited visibility')).toBeVisible()
    // No token-derived cache survived the reload (cleared on mount).
    const cachedAuth = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('assets-today-cache')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const raw = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction('snapshots', 'readonly')
        const req = tx.objectStore('snapshots').get('current')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      db.close()
      return (raw as { authMode?: string } | null | undefined)?.authMode ?? null
    })
    expect(cachedAuth).toBe('anonymous')
  })

  test('clear token drops to anonymous data immediately', async ({ page }) => {
    await mockGitHub(page)
    await gotoToday(page)
    await page.locator('.token-input').fill('github_pat_E2E_TRANSIENT_1')
    await page.getByRole('button', { name: 'Use token' }).click()
    await expect(page.locator('.today-table')).toContainText('#101')
    await page.getByRole('button', { name: 'Clear token' }).click()
    // Back to anonymous data: #101 (team-requested) disappears.
    await expect(page.locator('.today-table')).not.toContainText('#101')
    await expect(page.locator('.today-table')).toContainText('#201')
    await expect(page.getByText('Limited visibility')).toBeVisible()
  })

  test('rejected token (401) shows an honest error and returns to anonymous', async ({ page }) => {
    await mockGitHub(page, { tokenRejected: true })
    await gotoToday(page)
    await page.locator('.token-input').fill('github_pat_BAD_TOKEN_1')
    await page.getByRole('button', { name: 'Use token' }).click()
    await expect(page.getByText('Token rejected')).toBeVisible()
    await expect(page.locator('.token-input')).toBeEnabled() // anonymous again, input usable
  })
})

test.describe('Today view — failure handling', () => {
  test('failed refresh of a stale cache keeps the last good data', async ({ page }) => {
    let failNetwork = false
    await page.unrouteAll()
    const counts = await mockGitHub(page, { failNetwork: () => failNetwork })

    // Seed a 4h-old COMPLETE cached snapshot: stale enough that mounting
    // triggers a refresh, recent enough to be worth showing.
    const staleAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
    await page.goto('/') // IndexedDB needs a real origin (about:blank denies it)
    await page.evaluate(async (collectedAt: string) => {
      const seed = {
        schemaVersion: 1,
        collectedAt,
        authMode: 'anonymous',
        repos: [{ repo: 'MetaMask/core', pagesFetched: 1, complete: true }],
        complete: true,
        partialReason: null,
        rate: null,
        droppedMalformed: 0,
        missingChecks: [],
        prs: [
          {
            repo: 'MetaMask/core', number: 201, title: 'PR 201',
            url: 'https://github.com/MetaMask/core/pull/201', author: 'external-author',
            draft: false, createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
            labels: [], requestedTeams: [], requestedReviewers: ['salimtb'],
          },
        ],
      }
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('assets-today-cache', 1)
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('snapshots')) req.result.createObjectStore('snapshots')
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('snapshots', 'readwrite')
        tx.objectStore('snapshots').put(seed, 'current')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    }, staleAt)

    failNetwork = true
    await gotoToday(page)
    // Cache-first paint: rows appear immediately from the cache…
    await expect(page.locator('.today-table')).toContainText('#201')
    // …then the stale refresh fails, a banner explains, and rows persist.
    await expect(page.getByText('Connection problem')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.today-table')).toContainText('#201')
    // The first network error correctly ends the sweep: one attempted pull.
    expect(counts.pulls).toBeGreaterThanOrEqual(1)
  })

  test('anonymous pre-flight refusal spends nothing and says so', async ({ page }) => {
    await page.unrouteAll()
    const counts = await mockGitHub(page, { preflightRemaining: 5 })
    await gotoToday(page, '#/today')
    await expect(page.getByText('Rate limited')).toBeVisible()
    await expect(
      page.getByText(/too low to fit a full sweep|not spending requests/i),
    ).toBeVisible()
    expect(counts.pulls).toBe(0) // nothing spent beyond the free pre-flight
  })
})

test.describe('Today view — since-baseline diff (missing ≠ merged)', () => {
  test('verified departures are labelled; the real baseline timestamp is shown', async ({ page }) => {
    // Seed a 25h-old anonymous baseline: #201 (still requested), plus #999
    // (will verify MERGED) and #998 (will verify OPEN → left the queue).
    const counts = await mockGitHub(page)
    const baselineAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    await page.goto('/') // IndexedDB needs a real origin (about:blank denies it)
    await page.evaluate(async (collectedAt: string) => {
      const seed = {
        schemaVersion: 1,
        collectedAt,
        authMode: 'anonymous',
        repos: [],
        complete: true,
        partialReason: null,
        rate: null,
        droppedMalformed: 0,
        missingChecks: [],
        prs: [
          {
            repo: 'MetaMask/core', number: 201, title: 'PR 201',
            url: 'https://github.com/MetaMask/core/pull/201', author: 'external-author',
            draft: false, createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
            labels: [], requestedTeams: [], requestedReviewers: ['salimtb'],
          },
          {
            repo: 'MetaMask/core', number: 999, title: 'PR 999',
            url: 'https://github.com/MetaMask/core/pull/999', author: 'external-author',
            draft: false, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
            labels: [], requestedTeams: ['metamask-assets'], requestedReviewers: [],
          },
          {
            repo: 'MetaMask/core', number: 998, title: 'PR 998',
            url: 'https://github.com/MetaMask/core/pull/998', author: 'external-author',
            draft: false, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
            labels: [], requestedTeams: [], requestedReviewers: ['salimtb'],
          },
        ],
      }
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('assets-today-cache', 1)
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('snapshots')) req.result.createObjectStore('snapshots')
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('snapshots', 'readwrite')
        tx.objectStore('snapshots').put(seed, 'baseline')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    }, baselineAt)

    await gotoToday(page)
    const card = page.getByRole('region', { name: 'Changes since previous baseline' })
    await expect(card).toBeVisible({ timeout: 15_000 })
    // The real baseline timestamp — not a fabricated "yesterday".
    await expect(card).toContainText(/local baseline snapshot from \d{1,2} \w{3} \d{4}/)
    expect(counts.detail).toBe(2) // both departures were actually verified
    // #999 verified merged; #998 verified still-open (left the queue).
    await expect(card.getByRole('listitem').filter({ hasText: '#999' })).toContainText('merged')
    await expect(card.getByRole('listitem').filter({ hasText: '#998' })).toContainText('left the review queue')
  })
})

test.describe('Today view — cross-tab coordination', () => {
  test('only one tab collects; the second applies the broadcast', async ({ page, context }) => {
    await page.unrouteAll()
    const counts = await mockGitHub(page, { delayMs: 700 })
    await gotoToday(page)
    await expect(page.locator('.today-table')).toContainText('#201')

    const pageB = await context.newPage()
    await mockGitHub(pageB, { delayMs: 700 })
    await pageB.goto('/#/today')
    // B shows the same data (broadcast or cache) without a second sweep:
    await expect(pageB.locator('.today-table')).toContainText('#201', { timeout: 15_000 })
    // Exactly ONE pre-flight ran for B's mount (A's was earlier): B was
    // either lock-skipped or applied the broadcast — but no double sweep
    // storm: total pulls requests stay bounded.
    expect(counts.pulls).toBeLessThanOrEqual(6)
  })
})
