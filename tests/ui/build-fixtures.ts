import { spawnSync } from 'node:child_process'
import { UI_VARIANTS } from './variants'

/**
 * Builds every UI test variant (see ./variants.ts) as a production bundle so
 * Playwright can run each e2e spec against built output — the same build path
 * (virtual:dashboard-data embedding) used by real deployments.
 *
 * Every variant must pin its fixture via DASHBOARD_DATA_PATH: with real
 * data/dashboard.json committed on the default branch, an unpinned build would
 * silently embed REAL data (that is how the demo variant broke when the
 * collector landed). tests/ui/variants.test.ts enforces the pinning.
 *
 * Run via `bun run build:test-fixtures`. Cross-platform: no shell env-var
 * prefixes; DASHBOARD_DATA_PATH is passed through child-process env directly.
 */

for (const variant of UI_VARIANTS) {
  if (!variant.fixture) {
    process.stderr.write(
      `variant "${variant.name}" must pin a fixture (DASHBOARD_DATA_PATH) — ` +
        `an unpinned build would fall back to data/dashboard.json and embed real data\n`,
    )
    process.exit(1)
  }
  const env: Record<string, string | undefined> = { ...process.env }
  env.DASHBOARD_DATA_PATH = variant.fixture
  process.stdout.write(`▸ building variant "${variant.name}" → ${variant.outDir}\n`)
  const result = spawnSync('bunx', ['vite', 'build', '--outDir', variant.outDir], {
    stdio: 'inherit',
    env,
  })
  if (result.status !== 0) {
    process.stderr.write(`build failed for variant "${variant.name}"\n`)
    process.exit(result.status ?? 1)
  }
}
