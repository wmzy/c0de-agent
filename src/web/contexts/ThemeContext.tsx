import { darkTheme, lightTheme } from 'haze-ui/tokens'
import type { ReactNode } from 'react'
import { createContext, useContext, useEffect, useState } from 'react'

type ThemeMode = 'light' | 'dark' | 'system'

type ThemeContextValue = {
  mode: ThemeMode
  resolved: 'light' | 'dark'
  setMode: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(
    () => (localStorage.getItem('c0de-theme') as ThemeMode | null) ?? 'system',
  )
  const resolved = mode === 'system' ? getSystemTheme() : mode

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle(darkTheme, resolved === 'dark')
    root.classList.toggle(lightTheme, resolved === 'light')
    localStorage.setItem('c0de-theme', mode)
  }, [mode, resolved])

  useEffect(() => {
    if (mode !== 'system') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      const root = document.documentElement
      root.classList.toggle(darkTheme, mql.matches)
      root.classList.toggle(lightTheme, !mql.matches)
    }
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [mode])

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode }}>{children}</ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
