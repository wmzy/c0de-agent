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
   * 回归：搜索结果里的目录行此前与文件行走同一条 onPick（打开预览）。
   *
   * 缺陷：读接口对目录执行 readFile 抛 EISDIR → 404，点文件夹必然得到
   * 「文件读取失败 / File not found」，而同一路径在文件树里点却是展开语义。
   * 现在目录行回到文件树并展开定位到该目录。
   */
  it('点搜索结果里的目录行回到文件树并展开定位，不打开预览', async () => {
    const onPick = vi.fn()
    vi.mocked(fileAPI.search).mockResolvedValue([
      { path: 'src', type: 'directory' },
      { path: 'src/cli', type: 'directory' },
      { path: 'src/a.ts', type: 'file' },
    ])
    vi.mocked(fileAPI.list).mockImplementation(async (dir: string) =>
      dir === '.'
        ? ROOT_ENTRIES
        : dir === 'src'
          ? [
              { name: 'a.ts', type: 'file' },
              { name: 'cli', type: 'directory' },
            ]
          : dir === 'src/cli'
            ? [{ name: 'index.ts', type: 'file' }]
            : [],
    )
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <FileBrowser projectId="p1" onPick={onPick} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('node-src')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('file-search'), { target: { value: 'src' } })
    await waitFor(() => expect(screen.getByTestId('file-src')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('file-src/cli'))

    // 退出搜索，回到文件树，目标目录及其祖先都已展开、子项已加载
    await waitFor(() => expect(screen.getByRole('tree', { name: '项目文件树' })).toBeTruthy())
    expect(screen.queryByRole('list', { name: '搜索结果' })).toBeNull()
    expect(screen.getByTestId('toggle-src')).toBeTruthy()
    expect(screen.getByTestId('node-src/cli')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('index.ts')).toBeTruthy())
    // 目录不触发打开预览
    expect(onPick).not.toHaveBeenCalled()
    expect(vi.mocked(fileAPI.list)).toHaveBeenCalledWith('src/cli', 'p1')
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

/**
 * 回归：文件面板把「拉不到/搜不了」渲染成「加载中…/无匹配文件」。
 *
 * 缺陷一：根目录列目录是裸 promise + `.catch(() => {})`，treeRoot 恒为 null，
 * 面板永远停在「加载中…」，没有原因也没有重试入口——用户只能反复刷新整页。
 * 缺陷二：搜索没有 isError 分支，重试耗尽后 data=undefined 直接落进空态，把
 * 「查不到」说成「不存在」，用户会据此判定文件没有并去重建同名文件。
 */
describe('FileBrowser 读失败态', () => {
  it('根目录列出失败时展示原因与重试，而不是永远「加载中…」', async () => {
    vi.mocked(fileAPI.list).mockRejectedValueOnce({ message: '后端 500' })
    renderBrowser()

    const err = await screen.findByTestId('file-tree-error')
    expect(err.textContent).toContain('文件加载失败')
    expect(err.textContent).toContain('后端 500')
    expect(screen.queryByText('加载中…')).toBeNull()
  })

  it('点重试后重新拉取根目录并渲染出文件树', async () => {
    vi.mocked(fileAPI.list).mockRejectedValueOnce({ message: '后端 500' })
    renderBrowser()
    await screen.findByTestId('file-tree-error')

    fireEvent.click(screen.getByTestId('file-tree-retry'))
    await waitFor(() => {
      expect(screen.getByTestId('node-src')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('file-tree-error')).toBeNull()
  })

  it('搜索失败展示原因与重试，而不是「无匹配文件」', async () => {
    vi.mocked(fileAPI.search).mockRejectedValueOnce({ message: '扫描超时' })
    renderBrowser()
    fireEvent.change(screen.getByTestId('file-search'), { target: { value: 'zzz' } })

    const err = await screen.findByTestId('file-search-error', {}, { timeout: 2000 })
    expect(err.textContent).toContain('搜索失败')
    expect(err.textContent).toContain('扫描超时')
    expect(screen.queryByText('无匹配文件')).toBeNull()
  })

  it('搜索重试成功后回到结果列表', async () => {
    vi.mocked(fileAPI.search)
      .mockRejectedValueOnce({ message: '扫描超时' })
      .mockResolvedValue([{ path: 'src/a.ts', type: 'file' }])
    renderBrowser()
    fireEvent.change(screen.getByTestId('file-search'), { target: { value: 'a' } })
    await screen.findByTestId('file-search-error', {}, { timeout: 2000 })

    fireEvent.click(screen.getByTestId('file-search-retry'))
    await waitFor(() => {
      expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('file-search-error')).toBeNull()
  })
})

/**
 * 删除此前走 window.confirm + window.alert：原生框不可样式化；更糟的是失败
 * 时只弹「删除失败，请重试」，后端 404 的 message（"File not found"）被整句
 * 丢掉，用户只能对同一路径反复点删除。改为应用内确认层 + 原因留框内。
 */
describe('FileBrowser 删除确认', () => {
  async function openDeleteConfirm() {
    renderBrowser()
    await screen.findByTestId('node-package.json')
    fireEvent.click(screen.getByTestId('delete-package.json'))
  }

  it('点 🗑 先弹确认层，未确认前不发删除请求', async () => {
    await openDeleteConfirm()

    const dialog = screen.getByTestId('file-delete-dialog')
    expect(dialog.textContent).toContain('package.json')
    expect(dialog.textContent).toContain('回收站')
    expect(fileAPI.delete).not.toHaveBeenCalled()
  })

  it('确认后才发删除请求，成功后节点从树里消失、确认层关闭', async () => {
    await openDeleteConfirm()
    fireEvent.click(screen.getByTestId('file-delete-confirm'))

    await waitFor(() => {
      expect(fileAPI.delete).toHaveBeenCalledWith('package.json', 'p1')
    })
    await waitFor(() => {
      expect(screen.queryByTestId('node-package.json')).toBeNull()
    })
    expect(screen.queryByTestId('file-delete-dialog')).toBeNull()
  })

  it('取消不发删除请求，节点仍在', async () => {
    await openDeleteConfirm()
    fireEvent.click(screen.getByTestId('file-delete-cancel'))

    expect(fileAPI.delete).not.toHaveBeenCalled()
    expect(screen.queryByTestId('file-delete-dialog')).toBeNull()
    expect(screen.getByTestId('node-package.json')).toBeInTheDocument()
  })

  it('删除失败时把后端原因显示在确认层里（role=alert），节点不被移除', async () => {
    vi.mocked(fileAPI.delete).mockRejectedValueOnce({ message: 'File not found' })
    await openDeleteConfirm()
    fireEvent.click(screen.getByTestId('file-delete-confirm'))

    const err = await screen.findByTestId('file-delete-error')
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toContain('File not found')
    // 原因与操作必须同框可见：失败不关弹层
    expect(screen.getByTestId('file-delete-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('node-package.json')).toBeInTheDocument()
  })
})
