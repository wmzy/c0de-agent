import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LocaleProvider, ToastContainer, zhCN } from 'haze-ui'
import { describe, expect, it, vi } from 'vitest'
import { CopyButton } from '@/components/CopyButton.js'

describe('CopyButton', () => {
  it('点击后调用 clipboard 并以 toast 反馈已复制', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
    // ToastContainer 是 toast() 的渲染宿主；LocaleProvider 提供中文文案。
    render(
      <LocaleProvider strings={zhCN}>
        <ToastContainer>
          <CopyButton text="abc" />
        </ToastContainer>
      </LocaleProvider>,
    )
    await userEvent.click(screen.getByTestId('copy-button'))
    expect(writeText).toHaveBeenCalledWith('abc')
    // toast 浮层出现「已复制」反馈（按钮自身不再翻字）。
    await waitFor(() => expect(screen.getByText('已复制')).toBeTruthy())
    expect(screen.getByTestId('copy-button')).toHaveTextContent('复制')
  })
})
