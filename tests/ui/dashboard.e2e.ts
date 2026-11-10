import { test, expect, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import demoJson from '../../src/data/demo-fixture.json' with { type: 'json' }
import {
  aggregateMonths,
  durationSeries,
  displayWindow,
  firstReviewSamples,
  monthPeriods,
  orderedMonthKeys,
  prsReviewedIn,
  teamMergeSamples,
  totalAggregate,
  weekPeriods,
} from '../../src/data/metrics'
import type { DashboardData } from '../../src/data/types'
import { formatDurationMinutes, formatMonthKey } from '../../src/data/format'

const demo = demoJson as unknown as DashboardData
const monthKeys = orderedMonthKeys(demo.months)
const { shown: windowMonths } = displayWindow(monthKeys)
const allTotals = totalAggregate(aggregateMonths(demo.months, null, windowMonths))
const coreTotals = totalAggregate(aggregateMonths(demo.months, 'MetaMask/core', windowMonths))

const ROSTER = [
  'bergarces', 'sahar-fehri', 'Prithpal-Sooriya', 'Kriys94', 'salimtb',
  'juanmigdr', 'dawnseeker8', 'amandaye0h', 'amitabh94',
]

async function statValue(page: Page, label: string): Promise<string> {
  const card = page.locator('.stat', { hasText: label })
  await expect(card).toBeVisible()
  return (await card.locator('.stat__value').innerText()).trim()
}

test.beforeEach(async ({ page }) => {
  // Historical page content now lives at /historical (Daily is the root
  // landing page) — see src/routing.ts.
  await page.goto('/historical')
})

test('header and sample-data notice label synthetic data discreetly and accurately', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 1, name: 'Assets review workload' })).toBeVisible()
  const notice = page.locator('.notice--sample')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('Sample data')
  await expect(notice).toContainText('Synthetic figures for development')
  await expect(notice).toContainText('not real GitHub activity')
  await expect(page.locator('.site-header .chip')).toContainText('Sample data')
  // Never label invented figures as real: the real-source line must not appear.
  await expect(page.locator('.notice')).not.toContainText('Source: public GitHub PRs')
})

test('overview stats match the fixture aggregates', async ({ page }) => {
  const reviewed = allTotals.internalReviewedPrs + allTotals.externalReviewedPrs
  expect(await statValue(page, 'Reviewed PRs')).toBe(reviewed.toLocaleString('en-US'))
  expect(await statValue(page, 'Review submissions')).toBe(allTotals.reviewSubmissions.toLocaleString('en-US'))
  expect(await statValue(page, 'Reviewed & unmerged')).toBe(allTotals.reviewedUnmergedPrs.toLocaleString('en-US'))
  expect(await statValue(page, 'Merged internal')).toBe(allTotals.mergedInternalPrs.toLocaleString('en-US'))
  expect(await statValue(page, 'Merged external with review')).toBe(allTotals.mergedExternalReviewedPrs.toLocaleString('en-US'))
})

test('timeline chart renders one accessible group per month and selects via click', async ({ page }) => {
  const chart = page.locator('svg.chart[role="group"]')
  await expect(chart).toBeVisible()
  await expect(chart).toHaveAttribute('aria-label', /Reviewed PRs per month/)
  await expect(page.locator('.chart-wrap .hidden-visually').first()).toHaveText(
    /Stacked bar chart of reviewed pull requests per month/,
  )
  const groups = page.locator('.bar-group')
  await expect(groups).toHaveCount(windowMonths.length)
  await expect(groups.first()).toHaveAttribute('aria-label', new RegExp(`^${formatMonthKey(windowMonths[0]!)}`))

  const target = windowMonths[4]!
  await page.locator(`.bar-group[aria-label*="${formatMonthKey(target)}"]`).first().click()
  await expect(page.locator('#month-panel-title')).toContainText(formatMonthKey(target))
  await expect(page.locator('#month-select')).toHaveValue(target)
})

test('timeline months are keyboard selectable', async ({ page }) => {
  const first = page.locator('.bar-group').first()
  await first.focus()
  await first.press('Enter')
  await expect(page.locator('#month-select')).toHaveValue(windowMonths[0]!)
  await expect(page.locator('#month-panel-title')).toContainText(formatMonthKey(windowMonths[0]!))
})

test('month drill-down lists PRs reviewed that month with minimal metadata', async ({ page }) => {
  const month = windowMonths[3]!
  await page.locator('#month-select').selectOption(month)
  await expect(page.locator('#month-panel-title')).toContainText(formatMonthKey(month))

  const monthAgg = aggregateMonths(demo.months, null, [month])[0]!
  const reviewed = monthAgg.internalReviewedPrs + monthAgg.externalReviewedPrs
  const expectedPrs = prsReviewedIn(demo.prs, month, null)
  const prTable = page.getByRole('table', { name: `PRs reviewed in ${formatMonthKey(month)}` })
  await expect(prTable).toBeVisible()
  const rows = prTable.locator('tbody tr')
  await expect(rows).toHaveCount(Math.min(expectedPrs.length, 100))
  expect(reviewed).toBeGreaterThan(0)

  const firstRow = rows.first()
  await expect(firstRow.locator('a.pr-link[target="_blank"]')).toHaveCount(1)
  await expect(firstRow.locator('.chip--internal, .chip--external')).toHaveCount(1)
})

test('repository filter narrows every panel', async ({ page }) => {
  await page.getByRole('button', { name: 'Core', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Core', exact: true })).toHaveAttribute('aria-pressed', 'true')

  const reviewed = coreTotals.internalReviewedPrs + coreTotals.externalReviewedPrs
  expect(await statValue(page, 'Reviewed PRs')).toBe(reviewed.toLocaleString('en-US'))

  await expect(page.getByRole('heading', { name: /Month details · .+ · Core/ })).toBeVisible()
  const repoTable = page.getByRole('table', { name: /Per-repository counts for/ })
  await expect(repoTable.locator('tbody tr')).toHaveCount(1)

  const month = windowMonths[3]!
  await page.locator('#month-select').selectOption(month)
  const corePrs = prsReviewedIn(demo.prs, month, 'MetaMask/core')
  const corePrTable = page.getByRole('table', { name: `PRs reviewed in ${formatMonthKey(month)}` })
  await expect(corePrTable.locator('tbody tr')).toHaveCount(Math.min(corePrs.length, 100))
})

test('merge-vs-review and unmerged sections present explicit semantics', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Merge throughput vs review coverage' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Internal: reviewed vs merged' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'External: reviewed vs merged' })).toBeVisible()
  await expect(page.getByText('Internal merges are team throughput and do not require a team review')).toBeVisible()
  await expect(page.getByText('External merges counted here had a qualifying team review at or before merge')).toBeVisible()

  await expect(page.getByRole('heading', { name: 'Reviewed and currently unmerged' })).toBeVisible()
  await expect(page.getByText('snapshot of current status, not the historical month-end state')).toBeVisible()
})

test('coverage panel shows completeness, partial months and details', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Data coverage' })).toBeVisible()
  await expect(page.getByText('35/39 repo-months complete')).toBeVisible()
  await expect(page.locator('.chip--partial').first()).toBeVisible()
  await expect(page.getByText('Incomplete months')).toBeVisible()
  await expect(page.getByText('Review search pagination capped during backfill; counts are a lower bound.')).toBeVisible()
  await expect(page.getByText('Captured through run cutoff 2026-11-07; month not yet complete.').first()).toBeVisible()
})

test('charts expose data tables for screen-reader access', async ({ page }) => {
  const details = page.locator('details.data-table')
  const count = await details.count()
  expect(count).toBeGreaterThanOrEqual(3)
  await details.first().locator('summary').click()
  const rows = details.first().locator('tbody tr')
  await expect(rows).toHaveCount(windowMonths.length)
})

test('theme toggle switches and persists', async ({ page }) => {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: 'Switch to dark theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'Switch to light theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('no roster or reviewer logins appear anywhere in the rendered page', async ({ page }) => {
  const body = (await page.locator('body').innerText()).toLowerCase()
  for (const login of ROSTER) {
    expect(body).not.toContain(login.toLowerCase())
  }
})

test('mobile viewport has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.waitForTimeout(250)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
})

test('footer records provenance, schema and privacy stance', async ({ page }) => {
  const footer = page.locator('.site-footer')
  await expect(footer).toContainText('Sample data (synthetic fixture)')
  await expect(footer).toContainText('src/data/demo-fixture.json')
  await expect(footer).toContainText('dashboard.json v1')
  await expect(footer).toContainText('no individual reviewer data')
})

test('has no detectable accessibility violations (axe)', async ({ page }) => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious).toEqual([])
})

test('weekly breakdown, time to first review and team time to merge are on the page', async ({ page }) => {
  const weekly = page.locator('section', { has: page.getByRole('heading', { name: 'Reviewed PRs per week' }) })
  await expect(weekly).toBeVisible()
  await expect(weekly.getByRole('img', { name: /Reviewed pull requests per week/ })).toBeVisible()

  const weekAxis = weekPeriods(demo.weeks, windowMonths)
  const internal = durationSeries(
    firstReviewSamples(demo.firstReviews.filter((s) => s.ownership === 'internal')),
    'week',
    weekAxis,
    null,
  )
  const firstReview = page.locator('section', { has: page.getByRole('heading', { name: 'Time to first review' }) })
  await expect(firstReview.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true')
  await expect(firstReview.locator('.timing-summary__value').first()).toHaveText(
    formatDurationMinutes(internal.summary.medianMinutes),
  )
  await firstReview.getByRole('button', { name: 'Month' }).click()
  await expect(firstReview.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true')
  await expect(firstReview.getByRole('img', { name: /Time to first review by month/ })).toBeVisible()
  const monthAxis = monthPeriods(windowMonths, demo.range.end)
  const internalMonth = durationSeries(
    firstReviewSamples(demo.firstReviews.filter((s) => s.ownership === 'internal')),
    'month',
    monthAxis,
    null,
  )
  await expect(firstReview.locator('.timing-summary__value').first()).toHaveText(
    formatDurationMinutes(internalMonth.summary.medianMinutes),
  )

  const merge = page.locator('section', { has: page.getByRole('heading', { name: 'Time to merge, team PRs' }) })
  const weeklyMerge = durationSeries(teamMergeSamples(demo.teamMerges), 'week', weekAxis, null)
  await expect(merge.getByRole('img', { name: /Time to merge for team pull requests by week/ })).toBeVisible()
  await expect(merge.locator('.timing-summary__value')).toHaveText(formatDurationMinutes(weeklyMerge.summary.medianMinutes))
  await merge.getByRole('button', { name: 'Month' }).click()
  await expect(merge.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true')
  await expect(merge.getByRole('img', { name: /Time to merge for team pull requests by month/ })).toBeVisible()
  const monthlyMerge = durationSeries(teamMergeSamples(demo.teamMerges), 'month', monthAxis, null)
  await expect(merge.locator('.timing-summary__value')).toHaveText(formatDurationMinutes(monthlyMerge.summary.medianMinutes))
})

test('window caption reflects the rolling 12+partial month default', async ({ page }) => {
  await expect(page.getByText('Window: Nov 2025 – Nov 2026 · 13 months with data')).toBeVisible()
})
