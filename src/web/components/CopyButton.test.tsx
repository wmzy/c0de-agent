import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LocaleProvider, ToastContainer, zhCN } from 'haze-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CopyButton } from '@/components/CopyButton.js'

// toast 走模块级队列，挂载的 ToastContainer 会回放此前未渲染的 toast：
// 不清理会让后一例断言到前一次用例的残留浮层上。
afterEach(cleanup)

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

  // 回归：两条失败路径此前都静默——浏览器无剪贴板 API（非安全上下文，
  // 如局域网 http 访问）时 `navigator.clipboard?.writeText()` 整条 optional
  // 链短路；权限被拒时是 rejected promise，无 catch。用户点完毫无反馈，
  // 只会以为按钮坏了。
  it('剪贴板被拒时给出失败提示，不静默', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Write permission denied'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
    render(
      <LocaleProvider strings={zhCN}>
        <ToastContainer>
          <CopyButton text="abc" />
        </ToastContainer>
      </LocaleProvider>,
    )
    await userEvent.click(screen.getByTestId('copy-button'))
    expect(writeText).toHaveBeenCalledWith('abc')
    await waitFor(() => expect(screen.getByText(/复制失败/)).toBeTruthy())
  })

  it('无剪贴板 API 时同样给出失败提示', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    })
    render(
      <LocaleProvider strings={zhCN}>
        <ToastContainer>
          <CopyButton text="abc" />
        </ToastContainer>
      </LocaleProvider>,
    )
    await userEvent.click(screen.getByTestId('copy-button'))
    await waitFor(() => expect(screen.getByText(/复制失败/)).toBeTruthy())
  })
})
