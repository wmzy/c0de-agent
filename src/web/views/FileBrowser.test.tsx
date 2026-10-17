/**
 * FileBrowser 基础渲染 smoke test + 树降噪/搜索列表语义。
 * commit 按钮已移至 TopBar → CommitButton，相关测试见 TopBar.test.tsx。
 * 文件树渲染详见 FileTree.test.tsx。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
 * 懒加载目录失败此前被 `catch {}` 吞掉：目录仍被标记为已展开，树里渲染出
 * 「（空）」——把「读不到」说成了「没有」，用户据此判定该目录是空的、不再重试。
 */
describe('FileBrowser 子目录加载失败', () => {
  it('展开失败时给出原因与重试，而不是「（空）」', async () => {
    vi.mocked(fileAPI.list)
      .mockResolvedValueOnce(ROOT_ENTRIES)
      .mockRejectedValueOnce({ message: 'EACCES: permission denied' })
    renderBrowser()
    await screen.findByTestId('node-src')
    fireEvent.click(screen.getByTestId('toggle-src'))

    const err = await screen.findByTestId('load-error-src')
    expect(err.textContent).toContain('EACCES: permission denied')
    expect(screen.queryByText('（空）')).toBeNull()
  })

  it('点重试重新拉取该目录，成功后就地渲染出子项', async () => {
    vi.mocked(fileAPI.list)
      .mockResolvedValueOnce(ROOT_ENTRIES)
      .mockRejectedValueOnce({ message: 'EACCES: permission denied' })
      .mockResolvedValueOnce([{ name: 'a.ts', type: 'file' }])
    renderBrowser()
    await screen.findByTestId('node-src')
    fireEvent.click(screen.getByTestId('toggle-src'))
    await screen.findByTestId('load-error-src')

    fireEvent.click(screen.getByTestId('load-retry-src'))
    await waitFor(() => {
      expect(screen.getByTestId('node-src/a.ts')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('load-error-src')).toBeNull()
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

/**
 * 回归：文件面板的「项目作用域复位」只清了一半——删除确认弹层与搜索词都留在
 * 上一个项目里。
 *
 * confirmDelete 用的是**当前** projectId，而弹层里写的是上一个项目的路径：切
 * 项目（顶栏项目下拉、浏览器后退/前进，两条都是 /projects/:projectId 同 path
 * 模板 → @native-router 复用子树，组件不重建）后点一次「删除」，删掉的是新项目
 * 里的同路径文件。搜索词同理：不复位就一直停在「搜索结果」分支，用上一个项目的
 * 词去搜新项目，命中不到就显示「无匹配文件」，用户据此判定新项目里没有这个文件
 * （侧栏会话搜索已按同一口径复位，文件面板此前漏了）。
 */
describe('FileBrowser 切项目复位', () => {
  function renderSwitchable(initialProjectId: string, onDelete?: (path: string) => void) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const ui = (projectId: string) => (
      <QueryClientProvider client={qc}>
        <FileBrowser projectId={projectId} onPick={vi.fn()} onDelete={onDelete} />
      </QueryClientProvider>
    )
    const view = render(ui(initialProjectId))
    return (projectId: string) => view.rerender(ui(projectId))
  }

  it('切项目后删除确认弹层关闭——确认键不会再删到新项目里的同路径文件', async () => {
    const switchTo = renderSwitchable('p1')
    await screen.findByTestId('node-package.json')
    fireEvent.click(screen.getByTestId('delete-package.json'))
    expect(screen.getByTestId('file-delete-dialog')).toBeInTheDocument()

    switchTo('p2')

    await waitFor(() => expect(screen.queryByTestId('file-delete-dialog')).toBeNull())
    expect(fileAPI.delete).not.toHaveBeenCalled()
  })

  it('切项目后搜索词复位——不再用上一个项目的词搜新项目', async () => {
    vi.mocked(fileAPI.search).mockResolvedValue([{ path: 'src/a.ts', type: 'file' }])
    const switchTo = renderSwitchable('p1')
    fireEvent.change(await screen.findByTestId('file-search'), { target: { value: 'src' } })
    await screen.findByTestId('file-src/a.ts')

    switchTo('p2')

    await waitFor(() => {
      expect((screen.getByTestId('file-search') as HTMLInputElement).value).toBe('')
    })
    expect(screen.queryByRole('list', { name: '搜索结果' })).toBeNull()
    expect(screen.getByTestId('node-package.json')).toBeInTheDocument()
  })

  /**
   * 回归：懒加载目录的请求在切项目之后才回来。
   *
   * dirPath 是项目内相对路径（'src'），两个项目的同名目录合并「恰好成功」、不报
   * 任何错；而 handleToggle 只在 children === undefined 时才加载，这份上一个项目的
   * 清单于是被永久缓存到刷新为止：树里列的是另一个仓库的文件名，点进去又按新项目
   * 读同路径文件——用户在一个项目里看着另一个项目的文件树。
   */
  it('切换项目后在途返回的目录列表不并进新项目的树', async () => {
    let resolveSrc: ((entries: FileEntry[]) => void) | undefined
    vi.mocked(fileAPI.list).mockImplementation((dir: string) => {
      if (dir === '.') return Promise.resolve(ROOT_ENTRIES)
      if (dir === 'src') {
        return new Promise<FileEntry[]>((resolve) => {
          resolveSrc = resolve
        })
      }
      return Promise.resolve([])
    })

    const switchTo = renderSwitchable('p1')
    await screen.findByTestId('node-src')
    fireEvent.click(screen.getByTestId('node-src')) // 展开 src：请求发出，保持在途

    switchTo('p2')
    await waitFor(() => expect(fileAPI.list).toHaveBeenCalledWith('.', 'p2'))

    expect(resolveSrc).toBeDefined() // 展开 src 必须真的发出请求，否则「在途返回」不成立
    resolveSrc?.([{ name: 'only-in-p1.ts', type: 'file' }])

    // 新项目的树里不得出现上一个项目的条目；src 仍是「未加载」，展开时会重新拉取
    await waitFor(() => expect(screen.getByTestId('node-src')).toBeInTheDocument())
    expect(screen.queryByTestId('node-src/only-in-p1.ts')).toBeNull()
    expect(fileAPI.list).not.toHaveBeenCalledWith('src', 'p2')
  })

  /**
   * 回归：confirmDelete 在 await 成功后无条件落地 setTreeRoot(removeNode)/
   * onDelete。删除请求在途时切项目（确认弹层虽随切换关闭，本函数已在途），而
   * path 是项目内相对路径：removeNode 会把**新项目**树里的同路径节点一并抹掉，
   * 并对新项目触发 onDelete——用户在 A 项目删文件，B 项目的同名文件从界面消失。
   */
  it('删除在途时切项目：成功后不动新项目的树、不对新项目触发 onDelete', async () => {
    let resolveDelete: ((v: { path: string; trashed: boolean }) => void) | undefined
    vi.mocked(fileAPI.delete).mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve
      }),
    )
    const onDelete = vi.fn()
    const switchTo = renderSwitchable('p1', onDelete)

    await screen.findByTestId('node-package.json')
    fireEvent.click(screen.getByTestId('delete-package.json'))
    fireEvent.click(screen.getByTestId('file-delete-confirm'))
    await waitFor(() => expect(fileAPI.delete).toHaveBeenCalledWith('package.json', 'p1'))

    // 删除在途时切到 p2：p2 也有自己的 package.json（根目录清单相同）
    switchTo('p2')
    await screen.findByTestId('node-package.json')

    await act(async () => {
      resolveDelete?.({ path: 'package.json', trashed: true })
      await new Promise((r) => setTimeout(r, 0))
    })

    // 新项目的同名文件不被抹掉，onDelete 也不落到新项目头上
    expect(screen.getByTestId('node-package.json')).toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()
  })

  /**
   * 回归：reveal 循环持有的是**发起时**的 loadChildren 闭包（内部固定发起时的
   * projectId），迭代之间隔着 await——切项目插进循环中间后，上一次 loadChildren
   * 的清单因世代不符被丢弃（gen 是发起时捕获的），循环却继续调下一次
   * loadChildren：它是切换**之后**才发起的，内部读到的是新世代、响应落地校验
   * 通过，旧项目的目录清单写进新项目的树并被缓存（handleToggle 只在
   * children === undefined 时加载，外来清单就此钉死到刷新为止）。
   */
  it('reveal 定位在途切项目：循环不得用旧闭包把旧项目的深层目录写进新项目的树', async () => {
    let resolveP1Src: ((entries: FileEntry[]) => void) | undefined
    vi.mocked(fileAPI.list).mockImplementation(async (dir: string, projectId?: string) => {
      if (dir === '.') return ROOT_ENTRIES
      if (dir === 'src' && projectId === 'p1') {
        return new Promise<FileEntry[]>((resolve) => {
          resolveP1Src = resolve
        })
      }
      if (dir === 'src' && projectId === 'p2') {
        return [
          { name: 'nested', type: 'directory' },
          { name: 'b.ts', type: 'file' },
        ]
      }
      if (dir === 'src/nested' && projectId === 'p1')
        return [{ name: 'only-in-p1.ts', type: 'file' }]
      if (dir === 'src/nested' && projectId === 'p2')
        return [{ name: 'only-in-p2.ts', type: 'file' }]
      return []
    })
    vi.mocked(fileAPI.search).mockResolvedValue([{ path: 'src/nested', type: 'directory' }])

    const switchTo = renderSwitchable('p1')
    // 先等根目录就绪（reveal 依赖 treeRoot 判断哪些祖先未加载），再搜索并点目录结果
    await screen.findByTestId('node-src')
    fireEvent.change(await screen.findByTestId('file-search'), { target: { value: 'nest' } })
    fireEvent.click(await screen.findByTestId('file-src/nested'))
    // reveal 第一层：list('src','p1') 发出并保持在途
    await waitFor(() => expect(resolveP1Src).toBeDefined())

    // 在途切到 p2，并在新项目里展开 src（新项目的 src 子项即时返回，含 nested）
    switchTo('p2')
    await screen.findByTestId('node-src')
    fireEvent.click(screen.getByTestId('node-src'))
    await screen.findByTestId('node-src/nested')

    // 旧项目 src 的响应现在才回来（世代不符，清单本身已被丢弃）
    await act(async () => {
      resolveP1Src?.([{ name: 'nested', type: 'directory' }])
      await new Promise((r) => setTimeout(r, 0))
    })

    // 循环不得继续用旧闭包按 p1 拉深层目录——那是切项目后才发起的请求，
    // 世代校验拦不住它，p1 的清单会写进 p2 的树并被缓存
    expect(fileAPI.list).not.toHaveBeenCalledWith('src/nested', 'p1')
    // p2 的 src/nested 仍是「未加载」：展开时按新项目拉取
    fireEvent.click(screen.getByTestId('node-src/nested'))
    await screen.findByTestId('node-src/nested/only-in-p2.ts')
    expect(screen.queryByTestId('node-src/nested/only-in-p1.ts')).toBeNull()
  })
})
