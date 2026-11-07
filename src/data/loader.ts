import { parseDashboardJson, validateDashboardData } from './validate'
import type { DashboardData } from './types'

export type DataSource = 'real' | 'demo' | 'none'

export interface LoadIssue {
  path: string
  message: string
}

interface LoadedBase {
  source: DataSource
  /** True when the data is the synthetic demo fixture (or carries its marker). */
  isDemo: boolean
  /** Repo-relative path of the embedded file (display only). */
  dataPath: string
  /** Read failure detail when a candidate path existed but could not be read. */
  loadError: string | null
  errors: LoadIssue[]
  warnings: LoadIssue[]
}

/**
 * Honest union: `data` (a VALIDATED DashboardData) only exists once the
 * payload passed validation. The invalid and missing states carry no data
 * object, so no component can dereference an unvalidated payload by mistake —
 * the compiler enforces what prose comments could not.
 */
export type LoadedDashboard =
  | (LoadedBase & {
      status: 'ok' | 'empty'
      data: DashboardData
      parseError: null
    })
  | (LoadedBase & {
      status: 'invalid'
      data: null
      parseError: string | null
    })
  | (LoadedBase & {
      status: 'missing'
      isDemo: false
      data: null
      parseError: null
    })

export type LoadStatus = LoadedDashboard['status']

const DEMO_NOTE_MARKER = 'DEMO SAMPLE DATA'

function detectDemoMarker(data: DashboardData): boolean {
  const notes = (data as { methodology?: { notes?: unknown } }).methodology?.notes
  return Array.isArray(notes) && notes.some((n) => typeof n === 'string' && n.includes(DEMO_NOTE_MARKER))
}

/**
 * Pure loader: turns build-time inputs into a renderable dashboard payload
 * with explicit states (ok / empty / invalid / missing). Kept free of
 * bundler-specific imports so it can be unit-tested directly.
 */
export function loadDashboard(input: {
  source: DataSource
  dataPath: string
  raw: string
  loadError: string | null
}): LoadedDashboard {
  const base = {
    source: input.source,
    dataPath: input.dataPath,
    loadError: input.loadError,
  }

  // Only a total absence of data is "missing". An existing-but-empty file
  // (e.g. a truncated collector write) must surface as an explicit invalid
  // state via the parser's "Data file is empty" error — never as "missing",
  // which would tell the operator the wrong thing.
  if (input.source === 'none') {
    return {
      ...base,
      status: 'missing',
      isDemo: false,
      parseError: null,
      data: null,
      errors: [],
      warnings: input.loadError ? [{ path: input.dataPath, message: input.loadError }] : [],
    }
  }

  const parsed = parseDashboardJson(input.raw)
  if (parsed.parseError || !parsed.data) {
    return {
      ...base,
      status: 'invalid',
      isDemo: input.source === 'demo',
      parseError: parsed.parseError ?? 'Unknown parse failure',
      data: null,
      errors: [{ path: '$', message: parsed.parseError ?? 'Unknown parse failure' }],
      warnings: input.loadError ? [{ path: input.dataPath, message: input.loadError }] : [],
    }
  }

  const data = parsed.data
  const { errors, warnings } = validateDashboardData(data)
  if (input.loadError) {
    warnings.push({ path: input.dataPath, message: input.loadError })
  }

  if (errors.length > 0) {
    return {
      ...base,
      status: 'invalid',
      isDemo: input.source === 'demo' || detectDemoMarker(data),
      parseError: null,
      data: null,
      errors,
      warnings,
    }
  }

  if (data.months.length === 0) {
    return {
      ...base,
      status: 'empty',
      isDemo: input.source === 'demo' || detectDemoMarker(data),
      parseError: null,
      data,
      errors,
      warnings,
    }
  }

  return {
    ...base,
    status: 'ok',
    isDemo: input.source === 'demo' || detectDemoMarker(data),
    parseError: null,
    data,
    errors,
    warnings,
  }
}
