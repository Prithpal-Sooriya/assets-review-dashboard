import { test, expect } from '@playwright/test'
import realJson from './fixtures/sample-real.json' with { type: 'json' }
import { aggregateMonths, displayWindow, orderedMonthKeys, totalAggregate } from '../../src/data/metrics'
import type { DashboardData } from '../../src/data/types'

const real = realJson as unknown as DashboardData
const windowMonths = displayWindow(orderedMonthKeys(real.months)).shown
const totals = totalAggregate(aggregateMonths(real.months, null, windowMonths))

test('real-shaped data renders without any demo labelling', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.notice--sample')).toHaveCount(0)
  await expect(page.locator('.site-header .chip')).toContainText('Data as of 31 Oct 2026, 08:00 UTC')
  await expect(page.locator('.notice')).toContainText('Source: public GitHub PRs from MetaMask Mobile, Core, and Extension')
  // displayPath shows the repo-relative tail (last 3 segments) of the data path
  await expect(page.locator('.notice')).toContainText('ui/fixtures/sample-real.json')
  await expect(page.locator('.site-footer')).toContainText('Real collected data')
})

test('window, totals and coverage reflect the fixture', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Window: Jul 2026 – Oct 2026 · 4 months with data')).toBeVisible()
  const reviewed = (totals.internalReviewedPrs + totals.externalReviewedPrs).toLocaleString('en-US')
  await expect(page.locator('.stat', { hasText: 'Reviewed PRs' }).locator('.stat__value')).toHaveText(reviewed)
  await expect(page.locator('.bar-group')).toHaveCount(4)
})

test('coverage panel spans the full collection window (regression: issue #7)', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Data coverage' })).toBeVisible()
  // Timeline stays scoped to months with data (fixture months[] = Jul–Oct),
  // asserted in the test above; the coverage panel spans the FULL range.
  // Exact real-dataset figures: 10/39 contract-window repo-months, 29 pending
  // (the fixture's coverage array is byte-identical to the real one).
  await expect(page.getByText('Covers the full collection window (Nov 2025 – Nov 2026)')).toBeVisible()
  await expect(page.getByText('10/39 repo-months complete')).toBeVisible()
  await expect(page.getByText('· 29 pending')).toBeVisible()
  // The grid shows every month in the range — including the 7 months with no
  // collected data at all (Nov 2025 … May 2026), all Pending.
  const panel = page.locator('section[aria-labelledby="coverage-title"]')
  const grid = panel.locator('table.data')
  await expect(grid.locator('tbody tr')).toHaveCount(13)
  await expect(grid.getByRole('row', { name: /Nov 2025/ }).locator('.chip--pending')).toHaveCount(3)
  await expect(grid.getByRole('row', { name: /May 2026/ }).locator('.chip--pending')).toHaveCount(3)
  // Complete months keep their chips
  await expect(grid.getByRole('row', { name: /Oct 2026/ }).locator('.chip--complete')).toHaveCount(3)
  // Every non-complete repo-month is listed and accessible — all 29, with the
  // collector's honest detail text.
  const incomplete = panel.locator('.issue-list li')
  await expect(incomplete).toHaveCount(29)
  await expect(incomplete.filter({ hasText: 'Core · Nov 2025 — pending: not collected' })).toHaveCount(1)
  await expect(incomplete.filter({ hasText: 'Extension · May 2026 — pending: not collected' })).toHaveCount(1)
  await expect(incomplete.filter({ hasText: 'Core · Jul 2026 — pending: not collected' })).toHaveCount(1)
})

test('methodology notes are shown verbatim', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Methodology & limitations' })).toBeVisible()
  await expect(page.getByText('Sample dataset for automated UI tests; synthetic values, not real activity.')).toBeVisible()
})
