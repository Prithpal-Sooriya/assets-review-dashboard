import { formatISOTimestamp, formatISODate } from '../../data/format'
import { diffSnapshots } from '../../today/diff'
import type { TodaySnapshot } from '../../today/normalize'

/**
 * Since-baseline change summary.
 *
 * Only rendered when THIS browser retained a usable baseline snapshot
 * (complete, same auth mode, 20h–7d old). Everything is labelled with the
 * baseline's ACTUAL timestamp — never a fabricated "yesterday". A PR that
 * left the queue is reported by what the bounded state check proved
 * (merged / closed / left review queue) or as unverified — disappearance is
 * never silently equated with merging.
 */
export function SinceYesterdayCard({
  baseline,
  current,
}: {
  baseline: TodaySnapshot
  current: TodaySnapshot
}) {
  const diff = diffSnapshots(baseline, current)

  const section = (
    title: string,
    view: typeof diff.needs,
    emptyText: string,
  ) => (
    <div className="mini-metric" style={{ gridColumn: 'auto' }}>
      <div className="mini-metric__label">{title}</div>
      <div className="mini-metric__value">
        +{view.newCount} / −{view.left.length}
      </div>
      <p className="section__note" style={{ margin: '4px 0 0' }}>
        {view.newCount === 0 && view.left.length === 0
          ? emptyText
          : `${view.newCount} new · ${view.left.length} left the queue`}
      </p>
      {view.left.length > 0 && (
        <ul className="issue-list" style={{ marginTop: 6 }}>
          {view.left.slice(0, 6).map((entry) => (
            <li key={`${entry.repo}#${entry.number}`}>
              <a className="pr-link" href={entry.url} target="_blank" rel="noreferrer">
                #{entry.number}
              </a>{' '}
              {entry.outcome === 'merged' ? 'merged' : entry.outcome === 'closed' ? 'closed without merging' : entry.outcome === 'left-queue' ? 'left the review queue (still open)' : 'left the queue — state not verified'}
            </li>
          ))}
          {view.left.length > 6 && <li>…and {view.left.length - 6} more</li>}
        </ul>
      )}
    </div>
  )

  return (
    <section className="section" aria-label="Changes since previous baseline">
      <h2 className="section__title">Since the last baseline</h2>
      <p className="section__desc">
        Compared against this browser&rsquo;s local baseline snapshot from{' '}
        <strong>{formatISOTimestamp(baseline.collectedAt)}</strong> ({formatISODate(baseline.collectedAt)}).
        Only PRs whose state was verified are called merged or closed; the rest are labelled
        unverified — leaving the queue is not the same as merging.
      </p>
      <div className="mini-metrics" style={{ gridTemplateColumns: undefined }}>
        {section('Needs Assets review', diff.needs, 'No change against the baseline.')}
        {section('Assets PRs awaiting others', diff.awaiting, 'No change against the baseline.')}
      </div>
    </section>
  )
}
