/**
 * FileBrowser commit 按钮测试。
 * 对应 src/web/views/FileBrowser.tsx 中的一键提交功能。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileBrowser } from './FileBrowser.js'

// ---- mocks ----
vi.mock('../services/file.js', () => ({
  fileAPI: {
    list: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    gitStatus: vi.fn().mockResolvedValue({}),
    gitCommit: vi.fn(),
    gitBranch: vi.fn().mockResolvedValue({ branch: 'main' }),
  },
}))

vi.mock('../contexts/ReferenceContext.js', () => ({
  useFileReference: () => ({ insertFileReference: vi.fn() }),
}))

vi.mock('../hooks/useSession.js', () => ({
  useProjects: () => ({ data: [{ id: 'p1', name: 'proj' }] }),
}))

function renderBrowser() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <FileBrowser projectId="p1" onPick={vi.fn()} />
    </QueryClientProvider>,
  )
}

describe('FileBrowser commit 按钮', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(cleanup)

  it('无变更时按钮 disabled 且不高亮', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({})

    renderBrowser()
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn')).toBeInTheDocument()
    })
    const btn = screen.getByTestId('git-commit-btn') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('data-has-changes')).toBeNull()
  })

  it('显示当前分支名', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({})
    ;(fileAPI.gitBranch as ReturnType<typeof vi.fn>).mockResolvedValue({ branch: 'feature/x' })

    renderBrowser()
    await waitFor(() => {
      expect(screen.getByTestId('git-branch-label').textContent).toContain('feature/x')
    })
  })

  it('有未提交变更时按钮高亮（data-has-changes）', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
      'bar.ts': 'untracked',
    })

    renderBrowser()
    await waitFor(() => {
      const btn = screen.getByTestId('git-commit-btn')
      expect(btn.getAttribute('data-has-changes')).toBe('true')
    })
    const btn = screen.getByTestId('git-commit-btn') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('只有 ignored 文件时按钮不高亮', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'node_modules/x.js': 'ignored',
    })

    renderBrowser()
    await waitFor(() => {
      const btn = screen.getByTestId('git-commit-btn')
      expect(btn.getAttribute('data-has-changes')).toBeNull()
    })
  })

  it('点击提交按钮调用 gitCommit API', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
    })
    ;(fileAPI.gitCommit as ReturnType<typeof vi.fn>).mockResolvedValue({
      committed: true,
      message: 'feat: update foo',
      hash: 'abc123',
      fileCount: 1,
    })

    renderBrowser()
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').getAttribute('data-has-changes')).toBe('true')
    })

    fireEvent.click(screen.getByTestId('git-commit-btn'))

    await waitFor(() => {
      expect(fileAPI.gitCommit).toHaveBeenCalledWith('p1')
    })
    // 成功后显示 ✓
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').textContent).toContain('已提交')
    })
  })

  it('提交失败时显示错误状态', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
    })
    ;(fileAPI.gitCommit as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('LLM error'),
    )

    renderBrowser()
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').getAttribute('data-has-changes')).toBe('true')
    })

    fireEvent.click(screen.getByTestId('git-commit-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').textContent).toContain('提交失败')
    })
  })
})
