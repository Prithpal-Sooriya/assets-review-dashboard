import type { LoadedDashboard } from '../data/loader'

export function WarningsCard({ loaded }: { loaded: LoadedDashboard }) {
  if (loaded.warnings.length === 0) return null
  return (
    <section className="section" aria-labelledby="warnings-title">
      <details>
        <summary id="warnings-title" className="section__title" style={{ cursor: 'pointer' }}>
          Data quality warnings ({loaded.warnings.length})
        </summary>
        <ul className="issue-list">
          {loaded.warnings.map((w, i) => (
            <li key={i}>
              <code>{w.path}</code> — {w.message}
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}

export function MethodologyCard({ loaded }: { loaded: LoadedDashboard }) {
  if (loaded.status !== 'ok' || !loaded.data) return null
  const { methodology, range } = loaded.data
  return (
    <section className="section" aria-labelledby="methodology-title">
      <h2 className="section__title" id="methodology-title">
        Methodology &amp; limitations
      </h2>
      <p className="section__note" style={{ marginTop: 6 }}>
        Methodology version {methodology.version}. Window {range.start} → {range.end} (end
        exclusive), all counting in UTC. Notes below are emitted by the data collector.
      </p>
      {methodology.notes.length > 0 && (
        <ul className="plain">
          {methodology.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
      <p className="section__note">
        This dashboard shows team-level aggregates and minimal PR metadata only. No individual
        reviewer data, rankings or comparisons are collected or displayed.
      </p>
    </section>
  )
}
