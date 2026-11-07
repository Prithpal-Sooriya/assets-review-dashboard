import { parseDashboardJson, validateDashboardData } from './validate'
import type { DashboardData } from './types'

export type DataSource = 'real' | 'demo' | 'none'
export type LoadStatus = 'ok' | 'empty' | 'invalid' | 'missing'

export interface LoadedDashboard {
  status: LoadStatus
  source: DataSource
  /** True when the data is the synthetic demo fixture (or carries its marker). */
  isDemo: boolean
  dataPath: string
  loadError: string | null
  parseError: string | null
  data: DashboardData | null
  errors: { path: string; message: string }[]
  warnings: { path: string; message: string }[]
}

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

  if (input.source === 'none' || input.raw === '') {
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
      data,
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
