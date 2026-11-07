import { formatISOTimestamp } from '../data/format'
import type { LoadedDashboard } from '../data/loader'

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

/**
 * Public-facing display helpers. State cards can render on a public URL, so
 * they never show build-host detail: paths are reduced to a repo-relative
 * tail, long errors are collapsed to one line, and quoted data values inside
 * messages are masked (the message text itself stays diagnostic; the raw
 * detail belongs to build logs, not the page).
 */
function displayPath(dataPath: string): string {
  const parts = dataPath.split('/')
  return parts.slice(-3).join('/')
}

function oneLine(text: string, max = 160): string {
  const first = text.split('\n')[0] ?? ''
  return first.length > max ? `${first.slice(0, max)}…` : first
}

function maskQuotedValues(message: string): string {
  return message.replace(/(["'`])[^"'`]{1,120}\1/g, '$1…$1')
}

/** Data file missing entirely (no real data, no demo fixture). */
export function MissingState({ loaded }: { loaded: LoadedDashboard }) {
  return (
    <StateCard title="No dashboard data available">
      <p>
        No dashboard data was found at build time. The dashboard embeds{' '}
        <code>data/dashboard.json</code> at build time from the repository filesystem (never from
        the GitHub API).
      </p>
      {loaded.loadError && <p>{maskQuotedValues(oneLine(loaded.loadError))}</p>}
      <p>
        Produce the data file with the collector (see docs/collection.md), commit it, and rebuild.
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
      {loaded.parseError && <p>{maskQuotedValues(oneLine(loaded.parseError))}</p>}
      <p>
        {loaded.errors.length} validation error{loaded.errors.length === 1 ? '' : 's'} in{' '}
        <code>{displayPath(loaded.dataPath)}</code>:
      </p>
      <ul className="issue-list" style={{ color: 'var(--text)' }}>
        {loaded.errors.slice(0, 20).map((e, i) => (
          <li key={i}>
            <code>{e.path}</code> — {maskQuotedValues(e.message)}
          </li>
        ))}
      </ul>
      {loaded.errors.length > 20 && <p>…and {loaded.errors.length - 20} more.</p>}
      <p>Regenerate data/dashboard.json with the collector (see docs/collection.md) and rebuild.</p>
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
