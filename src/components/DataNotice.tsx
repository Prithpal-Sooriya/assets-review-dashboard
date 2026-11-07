import { formatISOTimestamp, displayPath } from '../data/format'
import type { LoadedDashboard } from '../data/loader'

/**
 * Prominent banner for demo data (never let fixture numbers read as real
 * findings) plus quieter provenance info for real data.
 */
export function DataNotice({ loaded }: { loaded: LoadedDashboard }) {
  if (loaded.isDemo) {
    return (
      <div className="notice notice--demo" role="status">
        <span className="notice__label">Demo data</span>
        <div className="notice__body">
          <p>
            This page renders a synthetic sample fixture (<code>{displayPath(loaded.dataPath)}</code>). All
            numbers and PRs are fabricated for development and must not be read as real
            team activity or findings.
          </p>
          <p>
            Real data will be embedded at build time from <code>data/dashboard.json</code>{' '}
            (see docs/deployment.md).
          </p>
        </div>
      </div>
    )
  }
  if (loaded.status === 'ok' && loaded.data) {
    return (
      <div className="notice" role="status">
        <span className="notice__label">Source</span>
        <div className="notice__body">
          <p>
            Real data embedded at build time from <code>{displayPath(loaded.dataPath)}</code>, generated{' '}
            {formatISOTimestamp(loaded.data.generatedAt)} (methodology v
            {loaded.data.methodology.version}).
          </p>
        </div>
      </div>
    )
  }
  return null
}
