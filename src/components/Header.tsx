import { useTheme } from '../theme'
import { formatISOTimestamp } from '../data/format'
import type { LoadedDashboard } from '../data/loader'

export function Header({ loaded }: { loaded: LoadedDashboard }) {
  const { theme, toggle } = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <div className="site-header__titles">
          <h1 className="site-title">Assets review workload</h1>
          <p className="site-subtitle">
            Historical team-level view · MetaMask Core, Mobile and Extension ·
            internal metrics only, no individual data
          </p>
        </div>
        <div className="site-header__actions">
          {loaded.status === 'ok' && loaded.data && (
            <span className="chip chip--complete" title={`Data generated at ${loaded.data.generatedAt}`}>
              {loaded.isDemo ? 'Sample data' : `Data as of ${formatISOTimestamp(loaded.data.generatedAt)}`}
            </span>
          )}
          <button
            type="button"
            className="btn"
            onClick={toggle}
            aria-label={`Switch to ${next} theme`}
          >
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
        </div>
      </div>
    </header>
  )
}
