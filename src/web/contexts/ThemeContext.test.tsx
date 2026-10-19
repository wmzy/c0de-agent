import { act, cleanup, render, screen } from '@testing-library/react'
import { darkTheme, lightTheme } from 'haze-ui/tokens'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext.js'

function Probe() {
  const { resolved, mode } = useTheme()
  return (
    <div data-testid="probe">
      {mode}:{resolved}
    </div>
  )
}

/**
 * 可控的 `prefers-color-scheme` 替身：记录注册进来的 handler，让用例能真的
 * 触发一次「OS 换肤」（happy-dom 无法从外部改系统偏好）。
 */
function installMatchMedia(initialDark: boolean) {
  const handlers = new Set<() => void>()
  let dark = initialDark
  const mql = {
    get matches() {
      return dark
    },
    addEventListener: (_type: string, cb: () => void) => {
      handlers.add(cb)
    },
    removeEventListener: (_type: string, cb: () => void) => {
      handlers.delete(cb)
    },
  }
  vi.spyOn(window, 'matchMedia').mockImplementation(() => mql as unknown as MediaQueryList)
  return {
    setDark(next: boolean) {
      dark = next
      // 事件回调会 setState，用 act 让重渲染在断言前落地。
      act(() => {
        for (const cb of handlers) cb()
      })
    },
  }
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove(darkTheme, lightTheme)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('按模式在 documentElement 挂 haze 主题类', () => {
    localStorage.setItem('c0de-theme', 'dark')
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(document.documentElement.classList.contains(darkTheme)).toBe(true)
    expect(document.documentElement.classList.contains(lightTheme)).toBe(false)
    expect(screen.getByTestId('probe').textContent).toBe('dark:dark')
  })

  it('未在 Provider 内使用抛错', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow('useTheme must be used within ThemeProvider')
    spy.mockRestore()
  })

  // 复现：`resolved` 此前是渲染期直接读 matchMedia 算的，而 mql 的 change handler
  // 只改 documentElement 的类、不触发重渲染 → 上下文里的 resolved 冻结不变。
  // 订阅 resolved 的消费者（CodeEditor 的 CodeMirror 主题）于是停留在旧配色，
  // 页面已经跟着系统换肤、编辑器却还按上一种主题画语法高亮。
  it('跟随系统时 OS 换肤会更新 resolved（不再冻结在上一次渲染）', () => {
    localStorage.setItem('c0de-theme', 'system')
    const mql = installMatchMedia(false)
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('probe').textContent).toBe('system:light')
    expect(document.documentElement.classList.contains(lightTheme)).toBe(true)

    // OS 从浅色切到深色
    mql.setDark(true)

    expect(screen.getByTestId('probe').textContent).toBe('system:dark')
    expect(document.documentElement.classList.contains(darkTheme)).toBe(true)
    expect(document.documentElement.dataset.theme).toBe('dark')

    // 再切回浅色同样跟随
    mql.setDark(false)
    expect(screen.getByTestId('probe').textContent).toBe('system:light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  // 固定 light/dark 时系统主题变化不得反过来覆盖用户的显式选择。
  it('显式指定模式时不被 OS 主题变化改写', () => {
    localStorage.setItem('c0de-theme', 'light')
    const mql = installMatchMedia(false)
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('probe').textContent).toBe('light:light')

    mql.setDark(true)

    expect(screen.getByTestId('probe').textContent).toBe('light:light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  // 复现：localStorage 读点此前裸调且位于 useState 初始化器（渲染路径）——
  // 站点数据被禁（SecurityError）时整棵组件树抛错白屏；写点在 effect 里同样抛错。
  // 经 storage 助手降级后应照常渲染（回退 system 模式）。
  it('存储不可用时照常渲染（回退默认模式，不白屏）', () => {
    // 站点数据被禁：访问 window.localStorage 属性本身即抛 SecurityError
    //（比方法级 mock 更贴近真实失败形态）。
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    })
    try {
      render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      )
      expect(screen.getByTestId('probe').textContent).toMatch(/^system:(light|dark)$/)
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original)
    }
  })
})
