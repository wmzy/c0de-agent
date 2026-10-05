/**
 * FileBrowser 基础渲染 smoke test + 树降噪/搜索列表语义。
 * commit 按钮已移至 TopBar → CommitButton，相关测试见 TopBar.test.tsx。
 * 文件树渲染详见 FileTree.test.tsx。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileAPI } from '@/services/file.js'
import type { FileEntry } from '@/types/index.js'
import { FileBrowser } from '@/views/FileBrowser.js'

// ---- mocks ----
vi.mock('@/services/file.js', () => ({
  fileAPI: {
    list: vi.fn(),
    search: vi.fn(),
    gitStatus: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../contexts/ReferenceContext.js', () => ({
  useFileReference: () => ({ insertFileReference: vi.fn() }),
}))

vi.mock('../hooks/useSession.js', () => ({
  useProjects: () => ({ data: [{ id: 'p1', name: 'proj' }] }),
}))

/** 根目录条目：源码目录 + 噪音目录混合，验证内置忽略清单。 */
const ROOT_ENTRIES: FileEntry[] = [
  { name: 'src', type: 'directory' },
  { name: 'docs', type: 'directory' },
  { name: 'node_modules', type: 'directory' },
  { name: 'dist', type: 'directory' },
  { name: '.git', type: 'directory' },
  { name: 'package.json', type: 'file' },
]

afterEach(cleanup)

beforeEach(() => {
  vi.mocked(fileAPI.list).mockImplementation(async (dir: string) =>
    dir === '.' ? ROOT_ENTRIES : [],
  )
  vi.mocked(fileAPI.search).mockResolvedValue([])
  vi.mocked(fileAPI.gitStatus).mockResolvedValue({})
  vi.mocked(fileAPI.delete).mockResolvedValue({ path: '', trashed: true })
})

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

  /**
   * 回归：搜索框只有 placeholder，没有可访问名称。
   *
   * placeholder 不是可访问名称——读屏与语音控制只念 placeholder，且输入框
   * 一旦有值就不再朗读，搜索框会退化为无名称控件。会话搜索框
   * （session-search）早已补上 aria-label，文件搜索框被漏掉了。
   */
  it('文件搜索框有可访问名称（不只靠 placeholder）', async () => {
    renderBrowser()
    const input = (await screen.findByTestId('file-search')) as HTMLElement
    const name =
      input.getAttribute('aria-label') ??
      document.querySelector(`label[for="${input.getAttribute('id')}"]`)?.textContent
    expect(name?.trim() ?? '').not.toBe('')
  })

  it('加载后不再渲染 commit 按钮（已移至 TopBar）', async () => {
    renderBrowser()
    await waitFor(() => {
      expect(screen.getByTestId('file-search')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('git-commit-btn')).toBeNull()
  })
})

describe('FileBrowser 树降噪（内置忽略清单）', () => {
  it('顶层默认隐藏 node_modules/dist/.git 等噪音目录', async () => {
    renderBrowser()
    await waitFor(() => {
      expect(screen.getByTestId('node-src')).toBeInTheDocument()
    })
    expect(screen.getByTestId('node-docs')).toBeInTheDocument()
    expect(screen.getByTestId('node-package.json')).toBeInTheDocument()
    expect(screen.queryByTestId('node-node_modules')).toBeNull()
    expect(screen.queryByTestId('node-dist')).toBeNull()
    expect(screen.queryByTestId('node-.git')).toBeNull()
  })

  it('点击「显示隐藏目录」开关找回噪音目录', async () => {
    renderBrowser()
    await waitFor(() => {
      expect(screen.getByTestId('node-src')).toBeInTheDocument()
    })
    const toggle = screen.getByTestId('toggle-hidden-dirs')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByTestId('node-node_modules')).toBeInTheDocument()
    expect(screen.getByTestId('node-dist')).toBeInTheDocument()
    expect(screen.getByTestId('node-.git')).toBeInTheDocument()
    // 源码目录仍在
    expect(screen.getByTestId('node-src')).toBeInTheDocument()
    // 再点一次回到过滤态
    fireEvent.click(toggle)
    expect(screen.queryByTestId('node-node_modules')).toBeNull()
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('FileBrowser 搜索结果语义', () => {
  it('搜索结果渲染为带 aria-label 的 list，行为 listitem', async () => {
    vi.mocked(fileAPI.search).mockResolvedValue([
      { path: 'src/a.ts', type: 'file' },
      { path: 'src/b.ts', type: 'file' },
    ])
    renderBrowser()
    fireEvent.change(screen.getByTestId('file-search'), { target: { value: '.ts' } })
    await waitFor(() => {
      expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    })
    const list = screen.getByRole('list', { name: '搜索结果' })
    expect(list).toBeInTheDocument()
    // 原生 li（隐式 listitem 语义）
    expect(list.querySelectorAll('li').length).toBe(2)
    expect(screen.getAllByRole('listitem').length).toBe(2)
    // 结果行常驻渲染 @ 引用与删除按钮（可见性由 CSS 保证）
    expect(screen.getByTestId('search-mention-src/a.ts')).toBeInTheDocument()
    expect(screen.getByTestId('search-delete-src/a.ts')).toBeInTheDocument()
  })

  /**
   * 回归：单字符查询此前被静默丢弃。
   *
   * 缺陷：isSearch 门槛是 `searchDebounced.length > 1`。输入 1 个字时既不发
   * 请求、也不进「搜索结果」分支，列出的仍是未过滤的整棵文件树——搜索框里
   * 有字、结果却没有收敛，用户只会以为「这个文件搜不到」。实测输入「s」列
   * 的是项目根目录，输入「se」才真正进入搜索结果。真正的防抖开销由 300ms
   * 防抖承担，不需要靠丢弃首字符来省。
   */
  it('单字符查询也进入搜索结果分支（不再回落到整棵树）', async () => {
    vi.mocked(fileAPI.search).mockResolvedValue([{ path: 'src/a.ts', type: 'file' }])
    renderBrowser()
    fireEvent.change(screen.getByTestId('file-search'), { target: { value: 's' } })

    await waitFor(
      () => {
        expect(vi.mocked(fileAPI.search)).toHaveBeenCalledWith('s', 'p1')
      },
      { timeout: 2000 },
    )
    // 进了搜索分支：结果列表在，且根目录树不在
    expect(screen.getByRole('list', { name: '搜索结果' })).toBeInTheDocument()
    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    expect(screen.queryByTestId('node-src')).toBeNull()
  })
})
