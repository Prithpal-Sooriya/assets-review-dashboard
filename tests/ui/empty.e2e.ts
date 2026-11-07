import { test, expect } from '@playwright/test'

test('valid but empty data shows a useful empty state', async ({ page }) => {
  await page.goto('/historical')
  await expect(page.getByRole('heading', { name: 'No review data in the captured window' })).toBeVisible()
  await expect(page.getByText('valid but contains no monthly records')).toBeVisible()
  await expect(page.getByText('2026-07-01T00:00:00Z → 2026-11-01T00:00:00Z').first()).toBeVisible()
  await expect(page.locator('.stat')).toHaveCount(0)
  await expect(page.locator('.bar-group')).toHaveCount(0)
})
