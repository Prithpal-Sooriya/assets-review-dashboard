import { formatInt } from '../data/format'
import type { MonthAggregate } from '../data/metrics'

interface StatCardsProps {
  total: MonthAggregate
}

export function StatCards({ total }: StatCardsProps) {
  const reviewed = total.internalReviewedPrs + total.externalReviewedPrs
  const cards: { label: string; value: string; hint: string }[] = [
    {
      label: 'Reviewed PRs',
      value: formatInt(reviewed),
      hint: `${formatInt(total.internalReviewedPrs)} internal · ${formatInt(total.externalReviewedPrs)} external`,
    },
    {
      label: 'Review submissions',
      value: formatInt(total.reviewSubmissions),
      hint: 'Approved, changes requested or commented; excludes pending and self-review',
    },
    {
      label: 'Reviewed & unmerged',
      value: formatInt(total.reviewedUnmergedPrs),
      hint: 'Snapshot as of data generation, not month-end state',
    },
    {
      label: 'Merged internal',
      value: formatInt(total.mergedInternalPrs),
      hint: 'Team throughput; merge does not require a team review',
    },
    {
      label: 'Merged external with review',
      value: formatInt(total.mergedExternalReviewedPrs),
      hint: 'External PRs merged with a qualifying team review at or before merge',
    },
  ]
  return (
    <div className="stats" role="list" aria-label="Totals for the displayed window">
      {cards.map((c) => (
        <div className="stat" role="listitem" key={c.label}>
          <div className="stat__label">{c.label}</div>
          <div className="stat__value">{c.value}</div>
          <div className="stat__hint">{c.hint}</div>
        </div>
      ))}
    </div>
  )
}
