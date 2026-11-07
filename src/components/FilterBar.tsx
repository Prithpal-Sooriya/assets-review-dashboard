import { repoDisplayName } from '../data/format'

interface FilterBarProps {
  repos: string[]
  repoFilter: string | null
  onRepoFilter: (repo: string | null) => void
  windowLabel: string
  omittedCount: number
}

export function FilterBar({ repos, repoFilter, onRepoFilter, windowLabel, omittedCount }: FilterBarProps) {
  return (
    <section className="section" aria-label="Filters">
      <div className="section__tools">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span id="repo-filter-label" className="stat__label">
            Repository
          </span>
          <div className="segmented" role="group" aria-labelledby="repo-filter-label">
            <button
              type="button"
              className="btn"
              aria-pressed={repoFilter === null}
              onClick={() => onRepoFilter(null)}
            >
              All
            </button>
            {repos.map((repo) => (
              <button
                key={repo}
                type="button"
                className="btn"
                aria-pressed={repoFilter === repo}
                onClick={() => onRepoFilter(repo)}
              >
                {repoDisplayName(repo)}
              </button>
            ))}
          </div>
        </div>
        <p className="section__note" style={{ margin: 0 }}>
          {windowLabel}
          {omittedCount > 0
            ? ` · ${omittedCount} earlier month${omittedCount === 1 ? '' : 's'} outside the rolling window omitted`
            : ''}
        </p>
      </div>
    </section>
  )
}
