import { useTheme } from '../theme'
import { formatISOTimestamp } from '../data/format'
import type { LoadedDashboard } from '../data/loader'
import { pageHref, type Page } from '../routing'

export function Header({ loaded, page }: { loaded: LoadedDashboard; page: Page }) {
  const { theme, toggle } = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <div className="site-header__titles">
          <h1 className="site-title">Assets review workload</h1>
          <p className="site-subtitle">
            {page === 'daily'
              ? 'Daily · open PRs needing Assets review · collected live in your browser from public GitHub data'
              : 'Historical team-level view · MetaMask Core, Mobile and Extension · internal metrics only, no individual data'}
          </p>
        </div>
        <div className="site-header__actions">
          {loaded.status === 'ok' && loaded.data && (
            <span className="chip chip--complete" title={`History data generated at ${loaded.data.generatedAt}`}>
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
      <nav className="site-nav" aria-label="Dashboard views">
        <div className="container site-nav__inner">
          <a className="site-nav__link" href={pageHref('daily')} aria-current={page === 'daily' ? 'page' : undefined}>
            Daily
          </a>
          <a className="site-nav__link" href={pageHref('historical')} aria-current={page === 'historical' ? 'page' : undefined}>
            Historical
          </a>
        </div>
      </nav>
    </header>
  )
}
