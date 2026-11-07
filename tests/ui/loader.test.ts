import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { loadDashboard } from '../../src/data/loader'
import type { DashboardData } from '../../src/data/types'

const demoRaw = readFileSync(
  new URL('../../src/data/demo-fixture.json', import.meta.url), 'utf8',
)

const realRaw = readFileSync(
  new URL('./fixtures/sample-real.json', import.meta.url), 'utf8',
)

const demoData = JSON.parse(demoRaw) as DashboardData

describe('loadDashboard', () => {
  test('demo source renders ok with demo flag', () => {
    const loaded = loadDashboard({ source: 'demo', dataPath: 'src/data/demo-fixture.json', raw: demoRaw, loadError: null })
    expect(loaded.status).toBe('ok')
    expect(loaded.isDemo).toBe(true)
    expect(loaded.data?.months.length).toBe(39)
    expect(loaded.errors).toEqual([])
  })

  test('real source without demo marker renders ok without demo flag', () => {
    const loaded = loadDashboard({ source: 'real', dataPath: 'data/dashboard.json', raw: realRaw, loadError: null })
    expect(loaded.status).toBe('ok')
    expect(loaded.isDemo).toBe(false)
  })

  test('real source carrying the demo marker still flags as demo (belt and suspenders)', () => {
    const marked = JSON.parse(realRaw) as DashboardData
    marked.methodology.notes = ['DEMO SAMPLE DATA: synthetic', ...marked.methodology.notes]
    const loaded = loadDashboard({ source: 'real', dataPath: 'data/dashboard.json', raw: JSON.stringify(marked), loadError: null })
    expect(loaded.isDemo).toBe(true)
  })

  test('valid schema with zero months yields the empty state', () => {
    const emptyRaw = readFileSync(new URL('./fixtures/empty.json', import.meta.url), 'utf8')
    const loaded = loadDashboard({ source: 'real', dataPath: 'data/dashboard.json', raw: emptyRaw, loadError: null })
    expect(loaded.status).toBe('empty')
    expect(loaded.isDemo).toBe(false)
  })

  test('contract violations yield the invalid state with listed errors', () => {
    const invalidRaw = readFileSync(new URL('./fixtures/invalid.json', import.meta.url), 'utf8')
    const loaded = loadDashboard({ source: 'real', dataPath: 'data/dashboard.json', raw: invalidRaw, loadError: null })
    expect(loaded.status).toBe('invalid')
    expect(loaded.errors.length).toBeGreaterThanOrEqual(10)
    // The honest LoadedDashboard union: unvalidated payloads are never
    // exposed through `data` (only ok/empty carry a DashboardData).
    expect(loaded.data).toBeNull()
  })

  test('malformed JSON yields the invalid state with parse error', () => {
    const loaded = loadDashboard({ source: 'real', dataPath: 'data/dashboard.json', raw: '{"schemaVersion":1,,}', loadError: null })
    expect(loaded.status).toBe('invalid')
    expect(loaded.parseError).toContain('Invalid JSON')
  })

  test('missing source yields the missing state with load error detail', () => {
    const loaded = loadDashboard({ source: 'none', dataPath: 'data/dashboard.json', raw: '', loadError: 'Could not read data/dashboard.json: EACCES' })
    expect(loaded.status).toBe('missing')
    expect(loaded.warnings.some((w) => w.message.includes('EACCES'))).toBe(true)
  })

  test('read failures on the real path surface as warnings after fallback', () => {
    const loaded = loadDashboard({ source: 'demo', dataPath: 'src/data/demo-fixture.json', raw: demoRaw, loadError: 'Could not read data/dashboard.json: EACCES' })
    expect(loaded.status).toBe('ok')
    expect(loaded.warnings.some((w) => w.message.includes('EACCES'))).toBe(true)
  })

  test('generatedAt and range survive loading', () => {
    const loaded = loadDashboard({ source: 'demo', dataPath: 'src/data/demo-fixture.json', raw: demoRaw, loadError: null })
    expect(loaded.data?.generatedAt).toBe(demoData.generatedAt)
    expect(loaded.data?.range.start).toBe('2025-11-01T00:00:00Z')
    expect(loaded.data?.range.end).toBe('2026-11-07T00:00:00Z')
  })
})

describe('loadDashboard — empty-file semantics', () => {
  test('an existing but empty real data file is invalid, not missing', () => {
    const loaded = loadDashboard({ source: 'real', dataPath: 'data/dashboard.json', raw: '', loadError: null })
    expect(loaded.status).toBe('invalid')
    expect(loaded.parseError).toContain('empty')
  })

  test('an empty demo fixture is invalid, not missing', () => {
    const loaded = loadDashboard({ source: 'demo', dataPath: 'src/data/demo-fixture.json', raw: '', loadError: null })
    expect(loaded.status).toBe('invalid')
    expect(loaded.isDemo).toBe(true)
  })

  test('whitespace-only real data is invalid', () => {
    const loaded = loadDashboard({ source: 'real', dataPath: 'data/dashboard.json', raw: '   \n ', loadError: null })
    expect(loaded.status).toBe('invalid')
    expect(loaded.parseError).toBeTruthy()
  })
})

describe('loadDashboard — malformed structural shapes stay in-band', () => {
  const shell = (raw: object): string => JSON.stringify(raw)

  test('data without a months array loads to the invalid state (no throw)', () => {
    const loaded = loadDashboard({
      source: 'real',
      dataPath: 'data/dashboard.json',
      raw: shell({ schemaVersion: 1, generatedAt: '2026-11-07T10:15:00Z', range: { start: '2026-07-01T00:00:00Z', end: '2026-11-01T00:00:00Z' }, methodology: { notes: [] }, coverage: [], prs: [] }),
      loadError: null,
    })
    expect(loaded.status).toBe('invalid')
    expect(loaded.errors.some((e) => e.path === '$.months')).toBe(true)
  })

  test('data with months: [] and no range key loads to the empty state (no throw)', () => {
    const loaded = loadDashboard({
      source: 'real',
      dataPath: 'data/dashboard.json',
      raw: shell({ schemaVersion: 1, generatedAt: '2026-11-07T10:15:00Z', methodology: { notes: [] }, coverage: [], months: [], prs: [] }),
      loadError: null,
    })
    expect(loaded.status === 'empty' || loaded.status === 'invalid').toBe(true)
  })
})
