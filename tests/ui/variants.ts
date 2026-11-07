/**
 * Single source of truth for the UI test variant matrix.
 *
 * Used by:
 *  - tests/ui/build-fixtures.ts  (`bun run build:test-fixtures`) — builds each
 *    variant's production bundle with the fixture pinned via DASHBOARD_DATA_PATH,
 *  - playwright.config.ts        — derives the per-variant project and preview
 *    webServer (ports 4173+) for every entry here,
 *  - .gitignore                  — a single dist-variants/ line covers every
 *    variant outDir (they are all nested under it).
 *
 * Adding/renaming a variant: edit this table — nothing else needs to change.
 */

export interface UiVariant {
  /** Playwright project name. */
  name: string
  /**
   * Fixture embedded for the build via DASHBOARD_DATA_PATH — REQUIRED, never
   * '' (build-fixtures.ts refuses; variants.test.ts enforces). Unpinned, the
   * build would resolve to data/dashboard.json first, and the collector
   * commits real data there: an unpinned "demo" build would silently embed
   * real data instead of the labelled synthetic fixture.
   */
  fixture: string
  /** Vite outDir for the built variant. */
  outDir: string
  /** Local preview port for the Playwright webServer. */
  port: number
  /** Which e2e spec file runs against this variant. */
  testMatch: RegExp
}

export const UI_VARIANTS: UiVariant[] = [
  {
    name: 'demo',
    // Pinned so the committed real data/dashboard.json can never leak into
    // the demo build (see the fixture field comment above).
    fixture: 'src/data/demo-fixture.json',
    outDir: 'dist-variants/demo',
    port: 4173,
    testMatch: /dashboard\.e2e\.ts/,
  },
  {
    name: 'real',
    fixture: 'tests/ui/fixtures/sample-real.json',
    outDir: 'dist-variants/real',
    port: 4174,
    testMatch: /real\.e2e\.ts/,
  },
  {
    name: 'empty',
    fixture: 'tests/ui/fixtures/empty.json',
    outDir: 'dist-variants/empty',
    port: 4175,
    testMatch: /empty\.e2e\.ts/,
  },
  {
    name: 'invalid',
    fixture: 'tests/ui/fixtures/invalid.json',
    outDir: 'dist-variants/invalid',
    port: 4176,
    testMatch: /invalid\.e2e\.ts/,
  },
]
