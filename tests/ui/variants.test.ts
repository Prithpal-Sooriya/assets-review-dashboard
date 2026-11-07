import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { UI_VARIANTS } from './variants'

/**
 * Every e2e variant must pin its build fixture explicitly.
 *
 * With real data/dashboard.json committed on the default branch, a variant
 * built without DASHBOARD_DATA_PATH would resolve to the REAL data first
 * (see vite.config.ts readDashboardBuildInput) and silently stop testing what
 * it claims to test — the demo variant broke exactly this way when the
 * collector landed. build-fixtures.ts refuses to build an unpinned variant;
 * this test keeps that contract visible in the unit suite.
 */
describe('UI_VARIANTS fixture pinning', () => {
  test('every variant pins a non-empty fixture', () => {
    for (const variant of UI_VARIANTS) {
      expect(variant.fixture).not.toBe('')
      expect(variant.fixture.length).toBeGreaterThan(0)
    }
  })

  test('every pinned fixture exists on disk', () => {
    for (const variant of UI_VARIANTS) {
      expect(
        existsSync(variant.fixture),
        `fixture for variant "${variant.name}" is missing: ${variant.fixture}`,
      ).toBe(true)
    }
  })

  test('the demo variant pins the labelled demo fixture (not the real-data fallback)', () => {
    const demo = UI_VARIANTS.find((v) => v.name === 'demo')
    expect(demo?.fixture).toBe('src/data/demo-fixture.json')
  })

  test('variant names, outDirs and ports are unique', () => {
    const by = (fn: (v: (typeof UI_VARIANTS)[number]) => unknown) =>
      new Set(UI_VARIANTS.map(fn)).size
    expect(by((v) => v.name)).toBe(UI_VARIANTS.length)
    expect(by((v) => v.outDir)).toBe(UI_VARIANTS.length)
    expect(by((v) => v.port)).toBe(UI_VARIANTS.length)
  })
})
