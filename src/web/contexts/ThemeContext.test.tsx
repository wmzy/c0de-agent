import { render, screen } from '@testing-library/react'
import { darkTheme, lightTheme } from 'haze-ui/tokens'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
})
