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
  // 「稍后」dismissal 记录在 localStorage（P2-8），跨用例隔离必须清掉
  localStorage.clear()
  vi.unstubAllGlobals()
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

  it('clicking 立即应用 calls updateAPI.apply（分级确认输入版本号）', async () => {
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
    // 分级确认弹层：确认按钮在输入正确版本号前禁用
    const confirmBtn = screen.getByTestId('danger-confirm-btn')
    expect(confirmBtn).toBeDisabled()
    fireEvent.change(screen.getByTestId('danger-confirm-input'), {
      target: { value: '0.2.0' },
    })
    expect(confirmBtn).not.toBeDisabled()
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(updateAPI.apply).toHaveBeenCalledTimes(1))
    // 成功后提示新版本已就绪（B1：建议刷新页面完成界面切换）
    await waitFor(() =>
      expect(screen.getByTestId('update-banner').textContent).toContain('新版本已就绪'),
    )
  })

  it('apply 确认弹窗取消时不调用 apply', async () => {
    ;(updateAPI.status as Mock).mockResolvedValue({
      hasUpdate: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
    })
    renderWithClient(<UpdateBanner />)
    await waitFor(() => expect(screen.getByTestId('update-apply')).toBeTruthy())
    fireEvent.click(screen.getByTestId('update-apply'))
    // 弹层打开；点击取消关闭
    fireEvent.click(screen.getByText('取消'))
    expect(updateAPI.apply).not.toHaveBeenCalled()
    expect(screen.queryByTestId('danger-confirm-btn')).toBeNull()
  })

  it('确认弹层列出将中断的对话与将关闭的终端标题', async () => {
    ;(updateAPI.status as Mock).mockResolvedValue({
      hasUpdate: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      impact: {
        runs: [{ sessionId: 's1', title: '修复登录 bug' }],
        terminalCount: 1,
        terminals: [{ id: 'p1', title: 'pnpm dev', shell: '/bin/zsh', cwd: '/repo' }],
      },
    })
    renderWithClient(<UpdateBanner />)
    await waitFor(() => expect(screen.getByTestId('update-apply')).toBeTruthy())
    fireEvent.click(screen.getByTestId('update-apply'))
    const dialog = screen.getByTestId('danger-confirm-dialog')
    expect(dialog.textContent).toContain('修复登录 bug')
    expect(dialog.textContent).toContain('pnpm dev')
    expect(dialog.textContent).toContain('/repo')
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

  it('clicking 稍后 keeps the banner hidden after remount in the same tab session', async () => {
    ;(updateAPI.status as Mock).mockResolvedValue({
      hasUpdate: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
    })
    const first = renderWithClient(<UpdateBanner />)
    await waitFor(() => expect(screen.getByTestId('update-dismiss')).toBeTruthy())
    fireEvent.click(screen.getByTestId('update-dismiss'))
    await waitFor(() => expect(screen.queryByTestId('update-banner')).toBeNull())
    first.unmount()

    // 重新挂载（模拟路由切换/刷新）：query 已返回 hasUpdate，但该版本已 dismiss
    renderWithClient(<UpdateBanner />)
    await waitFor(() => expect(updateAPI.status).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId('update-banner')).toBeNull())
    expect(localStorage.getItem('c0de-agent:updateDismissed')).toBe('0.2.0')
  })

  it('shows the banner again for a newer version after dismissing an older one', async () => {
    ;(updateAPI.status as Mock).mockResolvedValue({
      hasUpdate: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
    })
    const first = renderWithClient(<UpdateBanner />)
    await waitFor(() => expect(screen.getByTestId('update-dismiss')).toBeTruthy())
    fireEvent.click(screen.getByTestId('update-dismiss'))
    await waitFor(() => expect(screen.queryByTestId('update-banner')).toBeNull())
    first.unmount()

    ;(updateAPI.status as Mock).mockResolvedValue({
      hasUpdate: true,
      currentVersion: '0.2.0',
      latestVersion: '0.3.0',
    })
    renderWithClient(<UpdateBanner />)
    await waitFor(() => expect(screen.getByTestId('update-banner').textContent).toContain('0.3.0'))
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
    fireEvent.change(screen.getByTestId('danger-confirm-input'), {
      target: { value: '0.2.0' },
    })
    fireEvent.click(screen.getByTestId('danger-confirm-btn'))
    await waitFor(() => expect(updateAPI.apply).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId('update-banner').textContent).toContain('热更新失败'),
    )
  })
})
