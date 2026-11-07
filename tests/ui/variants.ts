/**
 * Single source of truth for the UI test variant matrix.
 *
 * Used by:
 *  - tests/ui/build-fixtures.ts  (`bun run build:test-fixtures`) — builds each
 *    variant's production bundle with the fixture pinned via DASHBOARD_DATA_PATH,
 *  - playwright.config.ts        — derives the per-variant project and preview
 *    webServer (ports 4173+) for every entry here,
 *  - .gitignore                  — lists the generated dist-* directories
 *    (kept in sync manually; gitignore cannot import).
 *
 * Adding/renaming a variant: edit this table, then update the matching
 * dist-* line(s) in .gitignore. Nothing else needs to change.
 */

export interface UiVariant {
  /** Playwright project name. */
  name: string
  /** Fixture embedded for the build (empty = demo fixture fallback, no override). */
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
    fixture: '',
    outDir: 'dist',
    port: 4173,
    testMatch: /dashboard\.e2e\.ts/,
  },
  {
    name: 'real',
    fixture: 'tests/ui/fixtures/sample-real.json',
    outDir: 'dist-real',
    port: 4174,
    testMatch: /real\.e2e\.ts/,
  },
  {
    name: 'empty',
    fixture: 'tests/ui/fixtures/empty.json',
    outDir: 'dist-empty',
    port: 4175,
    testMatch: /empty\.e2e\.ts/,
  },
  {
    name: 'invalid',
    fixture: 'tests/ui/fixtures/invalid.json',
    outDir: 'dist-invalid',
    port: 4176,
    testMatch: /invalid\.e2e\.ts/,
  },
]
