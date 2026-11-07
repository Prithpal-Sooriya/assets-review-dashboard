import { formatISOTimestamp } from '../../data/format'
import type { TodayController, TodayBanner } from '../../today/useTodayData'
import { isStale } from '../../today/ratelimit'
import { REFRESH_INTERVAL_MS } from '../../today/config'

function ageLabel(collectedAt: string, nowMs: number): string {
  const t = Date.parse(collectedAt)
  if (Number.isNaN(t)) return collectedAt
  const mins = Math.max(0, Math.floor((nowMs - t) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m ago`
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`
}

const BANNER_CLASS: Record<TodayBanner['kind'], string> = {
  partial: 'notice notice--warn',
  'rate-limited': 'notice notice--warn',
  'network-error': 'notice notice--error',
  'auth-rejected': 'notice notice--error',
  info: 'notice',
}

/**
 * Honest status header for Today: collection time, data age, auth mode,
 * coverage warnings. Says "no collection while the page is closed" rather
 * than implying background work, and never claims completeness it lacks.
 */
export function TodayStatus({ today, nowMs }: { today: TodayController; nowMs: number }) {
  const display = today.display
  return (
    <div>
      {today.banner !== null && (
        <div className={BANNER_CLASS[today.banner.kind]} role={today.banner.kind === 'network-error' || today.banner.kind === 'auth-rejected' ? 'alert' : 'status'}>
          <span className="notice__label">
            {today.banner.kind === 'partial'
              ? 'Incomplete data'
              : today.banner.kind === 'rate-limited'
                ? 'Rate limited'
                : today.banner.kind === 'network-error'
                  ? 'Connection problem'
                  : today.banner.kind === 'auth-rejected'
                    ? 'Token rejected'
                    : 'Note'}
          </span>
          <div className="notice__body">
            <p>{today.banner.message}</p>
            {today.banner.retryAtMs !== null && (
              <p>Next attempt after {formatISOTimestamp(new Date(today.banner.retryAtMs).toISOString())}.</p>
            )}
          </div>
        </div>
      )}

      <div className="today-meta">
        {display !== null ? (
          <>
            <span
              className={`chip ${display.complete ? 'chip--complete' : 'chip--partial'}`}
              title={`Collected ${formatISOTimestamp(display.collectedAt)}`}
            >
              {display.complete ? 'Complete' : 'Partial'} · {ageLabel(display.collectedAt, nowMs)}
            </span>
            {isStale(Date.parse(display.collectedAt), nowMs, REFRESH_INTERVAL_MS) && (
              <span className="chip chip--pending" title="Older than the 3-hour refresh interval">
                Stale — refresh due
              </span>
            )}
          </>
        ) : (
          <span className="chip chip--missing">{today.collecting ? 'Collecting…' : 'No data yet'}</span>
        )}
        <span
          className={`chip ${today.authMode === 'token' ? 'chip--internal' : 'chip--closed'}`}
          title={
            today.authMode === 'token'
              ? 'Authenticated REST — team review requests visible'
              : 'Anonymous REST — team review requests hidden by GitHub'
          }
        >
          {today.authMode === 'token' ? 'Token mode' : 'Anonymous mode'}
        </span>
        {today.collecting && (
          <span className="chip chip--open" role="status">
            Collecting from api.github.com…
          </span>
        )}
        {!today.cachePersistent && (
          <span className="chip chip--pending" title="IndexedDB unavailable — no local cache or baseline">
            No local cache
          </span>
        )}
      </div>
      {display !== null && (
        <p className="section__note">
          Collected {formatISOTimestamp(display.collectedAt)} from public GitHub REST data
          (open PRs in MetaMask Core, Mobile and Extension). Data is collected only while this
          page is open — no background collection happens with the tab closed.
        </p>
      )}
    </div>
  )
}
