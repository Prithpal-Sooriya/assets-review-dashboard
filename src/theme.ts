import { useCallback, useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'ard-theme'

export function getInitialTheme(): Theme {
  if (typeof document === 'undefined') return 'light'
  const current = document.documentElement.getAttribute('data-theme')
  if (current === 'dark' || current === 'light') return current
  return 'light'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // storage unavailable (private mode etc.) — theme still applies for this session
  }
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === 'dark' ? 'light' : 'dark'
      applyTheme(next)
      return next
    })
  }, [])
  useEffect(() => {
    // Normalise in case the inline init script failed.
    applyTheme(theme)
  }, [theme])
  return { theme, toggle }
}
