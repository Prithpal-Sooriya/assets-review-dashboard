import { loadDashboard, type LoadedDashboard } from './loader'
// Build-time binding: the vite plugin `dashboard-data` resolves this module to
// the contents of data/dashboard.json (or the demo fixture). Never the GitHub API.
import { source, dataPath, raw, loadError } from 'virtual:dashboard-data'

// A crash inside the load/validate machinery itself must degrade to the same
// explicit invalid state the UI already knows how to render — never a blank
// page (module-scope throw = React never mounts). The browser console gets
// the full error (message + stack) because there ARE no build logs for this
// path: this module runs client-side after a successful build.
let dashboardValue: LoadedDashboard
try {
  dashboardValue = loadDashboard({ source, dataPath, raw, loadError })
} catch (err) {
  console.error('[dashboard] loadDashboard threw during module init:', err)
  dashboardValue = {
    status: 'invalid',
    source,
    // Keep the demo label honest even on the crash path: a failed load of the
    // demo fixture must never render as "Real collected data" (Footer).
    isDemo: source === 'demo',
    dataPath,
    loadError,
    parseError: `Data loading failed unexpectedly: ${err instanceof Error ? err.name : 'unknown error'}`,
    data: null,
    errors: [{ path: '$', message: 'data loading threw; details were logged to the browser console' }],
    warnings: [],
  }
}
export const dashboard = dashboardValue
