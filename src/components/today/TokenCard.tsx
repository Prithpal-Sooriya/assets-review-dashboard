import { useId, useState } from 'react'
import type { TodayController } from '../../today/useTodayData'

/**
 * Optional GitHub personal access token input.
 *
 * - Password-type field; the value is used ONLY in memory: it is never
 *   written to any storage, URL, log or cache, and it disappears on reload.
 * - "Use token" triggers an authenticated collection (cache is cleared so
 *   anonymous-derived data never mixes with token-derived data).
 * - "Clear" drops the token and the auth-derived cache, then recollects
 *   anonymously.
 * - This is NOT a general manual refresh button: it exists to switch auth.
 */
export function TokenCard({ today }: { today: TodayController }) {
  const inputId = useId()
  const [value, setValue] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const active = today.authMode === 'token'

  const useToken = () => {
    const trimmed = value.trim()
    if (trimmed.length === 0) {
      setNotice('Enter a token first, or keep using the anonymous mode below.')
      return
    }
    setNotice(null)
    setValue('')
    today.activateToken(trimmed)
  }

  return (
    <section className="section" aria-label="Optional GitHub token">
      <h2 className="section__title">Optional: personal access token</h2>
      <p className="section__desc">
        Anonymous mode cannot see team review requests (GitHub hides them from unauthenticated
        calls), so the &ldquo;Needs Assets review&rdquo; list only shows direct reviewer requests.
        A read-only token makes team requests visible and lifts the rate budget.
      </p>
      <div className="token-row">
        <label htmlFor={inputId} className="stat__label">
          GitHub token
        </label>
        <input
          id={inputId}
          type="password"
          className="token-input"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="github_pat_… (optional)"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') useToken()
          }}
          disabled={active}
        />
        <button type="button" className="btn" onClick={useToken} disabled={active || today.collecting}>
          Use token
        </button>
        {active && (
          <button type="button" className="btn" onClick={today.clearAuth} disabled={today.collecting}>
            Clear token
          </button>
        )}
      </div>
      <p className="section__note">
        {active
          ? 'Token active — held in memory only. It is sent directly to api.github.com, never stored anywhere, and disappears when you reload the page.'
          : 'Memory only: the token is sent directly to api.github.com and is never stored, cached, logged or put in the URL. It is cleared when you reload.'}
        {' '}Create a fine-grained token with <em>Public repositories (read-only)</em> access and no
        additional permissions — nothing broader is needed or recommended.
      </p>
      {notice && (
        <p className="section__note" role="status">
          {notice}
        </p>
      )}
    </section>
  )
}
