import { loadDashboard, type LoadedDashboard } from './loader'
// Build-time binding: the vite plugin `dashboard-data` resolves this module to
// the contents of data/dashboard.json (or the demo fixture). Never the GitHub API.
import { source, dataPath, raw, loadError } from 'virtual:dashboard-data'

// A crash inside the load/validate machinery itself must degrade to the same
// explicit invalid state the UI already knows how to render — never a blank
// page (module-scope throw = React never mounts).
let dashboardValue: LoadedDashboard
try {
  dashboardValue = loadDashboard({ source, dataPath, raw, loadError })
} catch (err) {
  dashboardValue = {
    status: 'invalid',
    source,
    isDemo: false,
    dataPath,
    loadError,
    parseError: `Data loading failed unexpectedly: ${err instanceof Error ? err.name : 'unknown error'}`,
    data: null,
    errors: [{ path: '$', message: 'data loading threw; see build logs for details' }],
    warnings: [],
  }
}
export const dashboard = dashboardValue
