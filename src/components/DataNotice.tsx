import { formatISOTimestamp, displayPath } from '../data/format'
import type { LoadedDashboard } from '../data/loader'

/**
 * Discreet, accurate data-source labelling:
 *  - Sample-data builds (synthetic fixture) carry a small, always-visible
 *    "Sample data" strip — invented figures must never read as real GitHub
 *    activity, but the notice stays out of the way.
 *  - Real-data builds state their source: public GitHub PRs from MetaMask
 *    Mobile, Core, and Extension (collection coverage is shown in the
 *    coverage section).
 */
export function DataNotice({ loaded }: { loaded: LoadedDashboard }) {
  if (loaded.isDemo) {
    return (
      <div className="notice notice--sample" role="status">
        <span className="notice__label">Sample data</span>
        <div className="notice__body">
          <p>
            Synthetic figures for development — not real GitHub activity. Source fixture:{' '}
            <code>{displayPath(loaded.dataPath)}</code>.
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
            Source: public GitHub PRs from MetaMask Mobile, Core, and Extension — embedded at
            build time from <code>{displayPath(loaded.dataPath)}</code>, generated{' '}
            {formatISOTimestamp(loaded.data.generatedAt)} (methodology v
            {loaded.data.methodology.version}). Collection coverage is shown in the coverage
            section.
          </p>
        </div>
      </div>
    )
  }
  return null
}
