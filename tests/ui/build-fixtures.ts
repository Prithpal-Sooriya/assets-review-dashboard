import { spawnSync } from 'node:child_process'
import { UI_VARIANTS } from './variants'

/**
 * Builds every UI test variant (see ./variants.ts) as a production bundle so
 * Playwright can run each e2e spec against built output — the same build path
 * (virtual:dashboard-data embedding) used by real deployments.
 *
 * Run via `bun run build:test-fixtures`. Cross-platform: no shell env-var
 * prefixes; DASHBOARD_DATA_PATH is passed through child-process env directly.
 */

for (const variant of UI_VARIANTS) {
  const env: Record<string, string | undefined> = { ...process.env }
  if (variant.fixture) {
    env.DASHBOARD_DATA_PATH = variant.fixture
  } else {
    delete env.DASHBOARD_DATA_PATH // demo variant: fixture fallback, no override
  }
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
