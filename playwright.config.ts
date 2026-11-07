import { defineConfig } from '@playwright/test'
import { UI_VARIANTS } from './tests/ui/variants'

/**
 * UI e2e tests run against built preview servers (production build path,
 * including the build-time data loader) for every variant in
 * tests/ui/variants.ts (single source of truth: projects, ports and outDirs
 * are all derived from that table).
 *
 * Run `bun run test:ui` (builds all variants first) or
 * `bun run build:test-fixtures` manually.
 *
 * Browser: defaults to the locally installed Google Chrome (channel 'chrome',
 * no browser download). Set PW_CHANNEL to override for other environments,
 * e.g. PW_CHANNEL=chromium in CI after `bunx playwright install chromium`.
 */

const useChannel = process.env.PW_CHANNEL ?? 'chrome'

function previewServer(outDir: string, port: number, name: string) {
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
    channel: useChannel,
    headless: true,
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: UI_VARIANTS.map((variant) => ({
    name: variant.name,
    testMatch: variant.testMatch,
    use: { baseURL: `http://localhost:${variant.port}` },
  })),
  webServer: UI_VARIANTS.map((variant) =>
    previewServer(variant.outDir, variant.port, variant.name),
  ),
})
