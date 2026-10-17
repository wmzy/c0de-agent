import { darkTheme, lightTheme } from 'haze-ui/tokens'
import type { ReactNode } from 'react'
import { createContext, useContext, useEffect, useState } from 'react'
import { storageGet, storageSet } from '@/utils/storage.js'

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
    () => (storageGet('c0de-theme') as ThemeMode | null) ?? 'system',
  )
  /**
   * 系统偏好必须活在 state 里。
   *
   * 此前 `resolved` 是渲染期直接读 `getSystemTheme()` 算出来的，而 matchMedia 的
   * change handler **只改 documentElement 的类、不触发任何 React 重渲染**——于是
   * 上下文里的 `resolved` 冻结在上一次渲染的值：页面跟着系统换了配色，订阅
   * `resolved` 的组件（CodeEditor 的 CodeMirror 主题 keyed on [path, resolved]）
   * 还停在旧配色，暗色页面上配浅色主题的语法高亮，对比度也跟着错位。
   */
  const [system, setSystem] = useState<'light' | 'dark'>(getSystemTheme)
  const resolved = mode === 'system' ? system : mode

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle(darkTheme, resolved === 'dark')
    root.classList.toggle(lightTheme, resolved === 'light')
    // data-theme 供全局 CSS 做主题分支（shiki 双主题切换、light 态 token 覆写）——
    // haze 主题类名不可在 linaria 模板里静态引用，以此属性为稳定钩子。
    root.dataset.theme = resolved
    storageSet('c0de-theme', mode)
  }, [mode, resolved])

  // 始终监听、不按 mode 短路：否则用户停在固定 light/dark 时系统主题变了没人知道，
  // 再切回「跟随系统」会拿到一个陈旧的 system 值。setSystem 触发重渲染，
  // resolved 随之更新，上面的 effect 统一负责改类名（不再在 handler 里直接改 DOM）。
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => setSystem(mql.matches ? 'dark' : 'light')
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode }}>{children}</ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
