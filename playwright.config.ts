import { defineConfig } from '@playwright/test'

/**
 * UI e2e tests run against built preview servers (production build path,
 * including the build-time data loader) for four data variants:
 *   demo    — public/sample/demo-dashboard.json fallback (port 4173)
 *   real    — tests/ui/fixtures/sample-real.json via DASHBOARD_DATA_PATH (4174)
 *   empty   — valid schema, no records (4175)
 *   invalid — contract violations (4176)
 * Run `bun run test:ui` (builds all variants first) or `bun run build:test-fixtures` manually.
 * Uses the locally installed Google Chrome; no browser download required.
 */

function previewServer(port: number, outDir: string, name: string) {
  return {
    name,
    command: `bunx vite preview --outDir ${outDir} --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  }
}

export default defineConfig({
  testDir: 'tests/ui',
  testMatch: /.*\.e2e\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 4,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    headless: true,
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'demo', testMatch: /dashboard\.e2e\.ts/, use: { baseURL: 'http://localhost:4173' } },
    { name: 'real', testMatch: /real\.e2e\.ts/, use: { baseURL: 'http://localhost:4174' } },
    { name: 'empty', testMatch: /empty\.e2e\.ts/, use: { baseURL: 'http://localhost:4175' } },
    { name: 'invalid', testMatch: /invalid\.e2e\.ts/, use: { baseURL: 'http://localhost:4176' } },
  ],
  webServer: [
    previewServer(4173, 'dist', 'demo'),
    previewServer(4174, 'dist-real', 'real'),
    previewServer(4175, 'dist-empty', 'empty'),
    previewServer(4176, 'dist-invalid', 'invalid'),
  ],
})
