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
  await expect(page.getByText('Backfill still running.').first()).toBeVisible()
})

test('methodology notes are shown verbatim', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Methodology & limitations' })).toBeVisible()
  await expect(page.getByText('Sample dataset for automated UI tests; synthetic values, not real activity.')).toBeVisible()
})
