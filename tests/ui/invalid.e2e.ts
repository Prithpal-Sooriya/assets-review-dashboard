import { test, expect } from '@playwright/test'

test('contract-violating data refuses to render numbers', async ({ page }) => {
  await page.goto('/')
  const alert = page.getByRole('alert')
  await expect(alert).toBeVisible()
  await expect(alert.getByRole('heading', { name: 'Dashboard data failed validation' })).toBeVisible()
  await expect(alert.getByText('never renders numbers it cannot trust', { exact: false })).toBeVisible()
  await expect(page.locator('.stat')).toHaveCount(0)
  await expect(page.locator('.bar-group')).toHaveCount(0)
  await expect(alert.locator('li').first()).toBeVisible()
  const issues = await alert.locator('li').count()
  expect(issues).toBeGreaterThanOrEqual(10)
})

test('specific validation errors are listed with paths', async ({ page }) => {
  await page.goto('/')
  const alert = page.getByRole('alert')
  await expect(alert.getByText('$.schemaVersion', { exact: false })).toBeVisible()
  await expect(alert.getByText('$.months[0].internalReviewedPrs', { exact: false })).toBeVisible()
})
