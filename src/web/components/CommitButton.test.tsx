// CommitButton 组件测试，对应 src/web/components/CommitButton.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommitButton } from '@/components/CommitButton.js'
import { fileAPI } from '@/services/file.js'

vi.mock('@/services/file.js', () => ({
  fileAPI: {
    gitStatus: vi.fn(),
    gitCommit: vi.fn(),
  },
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('CommitButton', () => {
  it('有未提交变更时可点提交', async () => {
    vi.mocked(fileAPI.gitStatus).mockResolvedValue({ 'src/a.ts': 'modified' } as never)
    const commit = vi.mocked(fileAPI.gitCommit).mockResolvedValue({ message: 'ok' } as never)
    renderWithClient(<CommitButton projectId="p1" />)

    await waitFor(() =>
      expect((screen.getByTestId('git-commit-btn') as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId('git-commit-btn'))
    await waitFor(() => expect(commit).toHaveBeenCalledWith('p1', undefined))
  })

  // 复现：git-commit 失败时原因只写在顶栏按钮的 title 上，而此时审查弹窗是
  // showModal 的顶层 <dialog>——顶栏那行反馈被 ::backdrop 盖住，读屏与 Tab
  // 焦点也被 inert 挡住。用户点完「仍然提交」看到的是「点了没反应」，
  // 弹窗里三颗按钮还恒可点，能再排一次 commit。
  it('审查弹窗开着时提交失败，原因回到弹窗内且弹窗不消失', async () => {
    vi.mocked(fileAPI.gitStatus).mockResolvedValue({ 'dist/bundle.js': 'untracked' } as never)
    vi.mocked(fileAPI.gitCommit)
      .mockResolvedValueOnce({
        needsReview: true,
        message: 'feat: x',
        suggestions: ['dist/'],
      } as never)
      .mockRejectedValueOnce(new Error('pre-commit hook 拒绝了这次提交'))
    renderWithClient(<CommitButton projectId="p1" />)

    await waitFor(() =>
      expect((screen.getByTestId('git-commit-btn') as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId('git-commit-btn'))

    await waitFor(() => expect(screen.getByTestId('commit-review-dialog')).toBeTruthy())
    fireEvent.click(screen.getByTestId('commit-review-force'))

    await waitFor(() =>
      expect(screen.getByTestId('commit-review-error').textContent).toContain(
        'pre-commit hook 拒绝了这次提交',
      ),
    )
    // 失败后弹窗必须还在（原因就渲染在它里面），且允许重试。
    expect(screen.getByTestId('commit-review-dialog')).toBeTruthy()
    expect((screen.getByTestId('commit-review-force') as HTMLButtonElement).disabled).toBe(false)
  })

  // 复现：提交在飞时按 Esc 关掉弹窗，失败原因随卸载消失，用户零反馈。
  it('提交在飞时取消键不再关闭弹窗', async () => {
    let reject!: (e: unknown) => void
    vi.mocked(fileAPI.gitStatus).mockResolvedValue({ 'dist/bundle.js': 'untracked' } as never)
    vi.mocked(fileAPI.gitCommit)
      .mockResolvedValueOnce({
        needsReview: true,
        message: 'feat: x',
        suggestions: ['dist/'],
      } as never)
      .mockReturnValueOnce(
        new Promise((_res, rej) => {
          reject = rej
        }) as never,
      )
    renderWithClient(<CommitButton projectId="p1" />)

    await waitFor(() =>
      expect((screen.getByTestId('git-commit-btn') as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId('git-commit-btn'))
    await waitFor(() => expect(screen.getByTestId('commit-review-dialog')).toBeTruthy())

    fireEvent.click(screen.getByTestId('commit-review-force'))
    await waitFor(() =>
      expect((screen.getByTestId('commit-review-force') as HTMLButtonElement).disabled).toBe(true),
    )
    fireEvent.click(screen.getByTestId('commit-review-cancel'))
    expect(screen.getByTestId('commit-review-dialog')).toBeTruthy()

    reject(new Error('远端拒绝了 push'))
    await waitFor(() =>
      expect(screen.getByTestId('commit-review-error').textContent).toContain('远端拒绝了 push'),
    )
  })

  // 复现：不走审查弹窗的提交失败（pre-commit hook 拒绝、git user.email 未配置）
  // 此前原因只写进 haze-ui Tooltip 的 content，未悬停时那个 role=tooltip 气泡是
  // display:none 的空节点——真实浏览器实测：按钮上没有 aria-describedby/title，
  // ariaSnapshot 只读出「提交失败」，5 秒后连 tooltip 文案一起被 setTimeout 复位。
  // 触屏没有悬停、读屏不进气泡，用户拿到的只有四个字；即使鼠标用户也来不及读。
  it('直接提交失败的原因常驻渲染在按钮旁，不再只活在 tooltip 里', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      vi.mocked(fileAPI.gitStatus).mockResolvedValue({ 'src/a.ts': 'modified' } as never)
      vi.mocked(fileAPI.gitCommit).mockRejectedValue(
        new Error('pre-commit hook 拒绝了这次提交：ESLint 在 src/a.ts:12 报了 3 个错误'),
      )
      renderWithClient(<CommitButton projectId="p1" />)

      await waitFor(() =>
        expect((screen.getByTestId('git-commit-btn') as HTMLButtonElement).disabled).toBe(false),
      )
      fireEvent.click(screen.getByTestId('git-commit-btn'))

      const err = await waitFor(() => screen.getByTestId('commit-error'))
      expect(err.getAttribute('role')).toBe('alert')
      expect(err.textContent).toContain('pre-commit hook 拒绝了这次提交')

      // 5 秒后原因必须还在（旧的 5s 复位定时器会让这里查无此节点）
      await vi.advanceTimersByTimeAsync(6000)
      expect(screen.getByTestId('commit-error').textContent).toContain('pre-commit hook')
    } finally {
      vi.useRealTimers()
    }
  })
})
