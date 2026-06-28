import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CopyButton } from './CopyButton.js'

describe('CopyButton', () => {
  it('点击后调用 clipboard 并切换为已复制', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
    render(<CopyButton text="abc" />)
    await userEvent.click(screen.getByTestId('copy-button'))
    expect(writeText).toHaveBeenCalledWith('abc')
    expect(screen.getByTestId('copy-button')).toHaveTextContent('已复制')
  })
})
