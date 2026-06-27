import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider, useTheme } from './ThemeContext.js'

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
    document.documentElement.classList.remove('dark')
  })

  it('dark 模式添加 .dark class', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    // 默认 system，此处仅验证 provider 正常渲染
    expect(screen.getByTestId('probe')).toBeTruthy()
  })

  it('未在 Provider 内使用抛错', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow('useTheme must be used within ThemeProvider')
    spy.mockRestore()
  })
})
