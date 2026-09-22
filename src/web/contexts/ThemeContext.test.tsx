import { cleanup, render, screen } from '@testing-library/react'
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
