import { loadDashboard } from './loader'
// Build-time binding: the vite plugin `dashboard-data` resolves this module to
// the contents of data/dashboard.json (or the demo fixture). Never the GitHub API.
import { source, dataPath, raw, loadError } from 'virtual:dashboard-data'

export const dashboard = loadDashboard({ source, dataPath, raw, loadError })
