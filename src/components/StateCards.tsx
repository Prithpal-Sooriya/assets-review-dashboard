import { formatISOTimestamp, maskQuotedValues, oneLine, displayPath } from '../data/format'
import type { LoadedDashboard } from '../data/loader'

// displayPath/oneLine/maskQuotedValues live in src/data/format.ts — the single
// source of truth for how data paths and error text render on a public page.
// DataNotice and Footer import the same helpers.

function StateCard({
  title,
  children,
  tone = 'neutral',
}: {
  title: string
  children: React.ReactNode
  tone?: 'neutral' | 'error'
}) {
  return (
    <div className={`state-card${tone === 'error' ? ' notice notice--error' : ''}`} role="alert" style={tone === 'error' ? { display: 'block' } : undefined}>
      <h2 style={{ color: tone === 'error' ? 'var(--danger)' : undefined }}>{title}</h2>
      {children}
    </div>
  )
}

export function MissingState({ loaded }: { loaded: LoadedDashboard }) {
  return (
    <StateCard title="No dashboard data available">
      <p>
        No dashboard data was found at build time. The dashboard embeds{' '}
        <code>data/dashboard.json</code> at build time from the repository filesystem (never from
        the GitHub API).
      </p>
      {loaded.loadError && <p>{oneLine(maskQuotedValues(loaded.loadError))}</p>}
      <p>
        Produce the data file with the collector (see docs/deployment.md), commit it, and rebuild.
        A clearly-labelled demo fixture normally renders here for UI development.
      </p>
    </StateCard>
  )
}

/** Data present but structurally invalid — refuse to show wrong numbers. */
export function InvalidState({ loaded }: { loaded: LoadedDashboard }) {
  return (
    <StateCard title="Dashboard data failed validation" tone="error">
      <p>
        The embedded data file does not match the shared contract v1, so no metrics are shown —
        this page never renders numbers it cannot trust.
      </p>
      {loaded.parseError && <p>{oneLine(maskQuotedValues(loaded.parseError))}</p>}
      <p>
        {loaded.errors.length} validation error{loaded.errors.length === 1 ? '' : 's'} in{' '}
        <code>{displayPath(loaded.dataPath)}</code>:
      </p>
      <ul className="issue-list" style={{ color: 'var(--text)' }}>
        {loaded.errors.slice(0, 20).map((e, i) => (
          <li key={i}>
            <code>{e.path}</code> — {oneLine(maskQuotedValues(e.message))}
          </li>
        ))}
      </ul>
      {loaded.errors.length > 20 && <p>…and {loaded.errors.length - 20} more.</p>}
      <p>Regenerate data/dashboard.json with the collector (see docs/deployment.md) and rebuild.</p>
    </StateCard>
  )
}

/** Valid data, but nothing in the captured window. */
export function EmptyState({ loaded }: { loaded: LoadedDashboard }) {
  const data = loaded.data
  return (
    <StateCard title="No review data in the captured window">
      <p>
        The data file is valid but contains no monthly records
        {data ? ` for ${data.range.start} → ${data.range.end}` : ''}.
      </p>
      {data && <p>Data generated {formatISOTimestamp(data.generatedAt)}.</p>}
      <p>Re-run the collector for the intended window and rebuild.</p>
    </StateCard>
  )
}
