/**
 * FileBrowser 基础渲染 smoke test。
 * commit 按钮已移至 TopBar → CommitButton，相关测试见 TopBar.test.tsx。
 * 文件树渲染详见 FileTree.test.tsx。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileBrowser } from './FileBrowser.js'

// ---- mocks ----
vi.mock('../services/file.js', () => ({
  fileAPI: {
    list: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    gitStatus: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('../contexts/ReferenceContext.js', () => ({
  useFileReference: () => ({ insertFileReference: vi.fn() }),
}))

vi.mock('../hooks/useSession.js', () => ({
  useProjects: () => ({ data: [{ id: 'p1', name: 'proj' }] }),
}))

afterEach(cleanup)

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

describe('FileBrowser 基础渲染', () => {
  it('渲染搜索框', async () => {
    renderBrowser()
    await waitFor(() => {
      expect(screen.getByTestId('file-search')).toBeInTheDocument()
    })
  })

  it('加载后不再渲染 commit 按钮（已移至 TopBar）', async () => {
    renderBrowser()
    await waitFor(() => {
      expect(screen.getByTestId('file-search')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('git-commit-btn')).toBeNull()
  })
})
