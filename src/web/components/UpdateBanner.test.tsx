/**
 * UpdateBanner 组件测试。
 * 归并建议：本文件为 spec §18 自动升级前端横幅的单元测试，与设置/通知类组件同族；
 * 若后续合并全局通知组件，可并入对应测试文件。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateBanner } from './UpdateBanner.js'

vi.mock('../services/update.js', () => ({
  updateAPI: {
    status: vi.fn(),
    apply: vi.fn(),
  },
}))

const { updateAPI } = await import('../services/update.js')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('UpdateBanner', () => {
  it('renders nothing when no update', async () => {
    ;(updateAPI.status as Mock).mockResolvedValue({
      hasUpdate: false,
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
    })
    renderWithClient(<UpdateBanner />)
    await waitFor(() => expect(updateAPI.status).toHaveBeenCalled())
    expect(screen.queryByTestId('update-banner')).toBeNull()
  })

  it('renders banner when hasUpdate', async () => {
    ;(updateAPI.status as Mock).mockResolvedValue({
      hasUpdate: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
    })
    renderWithClient(<UpdateBanner />)
    await waitFor(() => expect(screen.getByTestId('update-banner')).toBeTruthy())
    expect(screen.getByTestId('update-banner').textContent).toContain('0.2.0')
    expect(screen.getByTestId('update-banner').textContent).toContain('0.1.0')
  })

  it('clicking 立即应用 calls updateAPI.apply', async () => {
    ;(updateAPI.status as Mock).mockResolvedValue({
      hasUpdate: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
    })
    ;(updateAPI.apply as Mock).mockResolvedValue({
      ok: true,
      snapshotPath: '/tmp/s.json',
      latestVersion: '0.2.0',
    })
    renderWithClient(<UpdateBanner />)
    await waitFor(() => expect(screen.getByTestId('update-apply')).toBeTruthy())
    fireEvent.click(screen.getByTestId('update-apply'))
    await waitFor(() => expect(updateAPI.apply).toHaveBeenCalledTimes(1))
    // 成功后显示"已触发热更新"
    await waitFor(() =>
      expect(screen.getByTestId('update-banner').textContent).toContain('已触发热更新'),
    )
  })

  it('clicking 稍后 dismisses the banner for current latest version', async () => {
    ;(updateAPI.status as Mock).mockResolvedValue({
      hasUpdate: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
    })
    renderWithClient(<UpdateBanner />)
    await waitFor(() => expect(screen.getByTestId('update-dismiss')).toBeTruthy())
    fireEvent.click(screen.getByTestId('update-dismiss'))
    await waitFor(() => expect(screen.queryByTestId('update-banner')).toBeNull())
  })

  it('shows failure message when apply throws', async () => {
    ;(updateAPI.status as Mock).mockResolvedValue({
      hasUpdate: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
    })
    ;(updateAPI.apply as Mock).mockRejectedValue(new Error('network'))
    renderWithClient(<UpdateBanner />)
    await waitFor(() => expect(screen.getByTestId('update-apply')).toBeTruthy())
    fireEvent.click(screen.getByTestId('update-apply'))
    await waitFor(() => expect(updateAPI.apply).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId('update-banner').textContent).toContain('热更新失败'),
    )
  })
})
