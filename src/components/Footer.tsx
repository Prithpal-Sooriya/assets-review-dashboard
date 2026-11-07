import { formatISOTimestamp, displayPath } from '../data/format'
import type { LoadedDashboard } from '../data/loader'

export function Footer({ loaded }: { loaded: LoadedDashboard }) {
  // `data` is non-null only in the ok/empty states (validated payloads — see
  // the LoadedDashboard union), so these rows can never dereference an
  // unvalidated object on the invalid/missing paths.
  const d = loaded.data
  return (
    <footer className="site-footer">
      <div className="container">
        <dl>
          <dt>Data</dt>
          <dd>
            {loaded.isDemo ? 'Synthetic demo fixture' : 'Real collected data'} embedded at build
            time from <code>{displayPath(loaded.dataPath)}</code>
            {loaded.source === 'none' && ' (not found)'}
          </dd>
          {d && <dt>Generated</dt>}
          {d && <dd>{formatISOTimestamp(d.generatedAt)}</dd>}
          {d && <dt>Window</dt>}
          {d && <dd>
            {d.range.start} → {d.range.end} (end exclusive, UTC)
          </dd>}
          {d && <dt>Schema</dt>}
          {d && <dd>dashboard.json v{d.schemaVersion}</dd>}
          {d && <dt>Methodology</dt>}
          {d && <dd>v{d.methodology.version}</dd>}
          <dt>Privacy</dt>
          <dd>Team-level aggregates only; no individual reviewer data is collected or displayed.</dd>
        </dl>
      </div>
    </footer>
  )
}
