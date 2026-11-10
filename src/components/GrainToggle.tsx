import type { TimeGrain } from '../data/metrics'

interface GrainToggleProps {
  grain: TimeGrain
  onChange: (grain: TimeGrain) => void
  label: string
}

/** Week / month switch for a historical timing chart. */
export function GrainToggle({ grain, onChange, label }: GrainToggleProps) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      <button type="button" className="btn" aria-pressed={grain === 'week'} onClick={() => onChange('week')}>
        Week
      </button>
      <button type="button" className="btn" aria-pressed={grain === 'month'} onClick={() => onChange('month')}>
        Month
      </button>
    </div>
  )
}
