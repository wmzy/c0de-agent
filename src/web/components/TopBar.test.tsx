// TopBar 组件测试，对应 src/web/components/TopBar.tsx
// TopBar 内嵌 ProjectIndicator（项目名/分支可下拉切换 + 添加按钮）+ CommitButton（提交按钮）。

import { createRoutes, MemoryRouter, View } from '@native-router/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TopBar } from '@/components/TopBar.js'

// ---- mocks ----
vi.mock('@/services/usage.js', () => ({
  usageAPI: { summary: vi.fn() },
}))

vi.mock('@/services/file.js', () => ({
  fileAPI: {
    gitStatus: vi.fn().mockResolvedValue({}),
    gitCommit: vi.fn(),
    gitLastCommit: vi.fn().mockResolvedValue({ commit: null }),
    gitBranches: vi.fn().mockResolvedValue({ branches: [] }),
    gitCheckout: vi.fn().mockResolvedValue({ branch: 'main' }),
    gitBranchCreate: vi.fn().mockResolvedValue({ branch: 'new-branch' }),
  },
}))

vi.mock('@/services/project.js', () => ({
  projectAPI: {
    remove: vi.fn(),
    // 顶栏「项目看板」入口在无路由 projectId 时用它解析当前项目。
    current: vi.fn(),
  },
}))

// AddProjectDialog 依赖 projectAPI + DirectoryPicker（需文件列表 API），
// 测试 TopBar 下拉交互时 mock 掉以隔离。
vi.mock('./AddProjectDialog.js', () => ({
  AddProjectDialog: ({
    onClose,
    onCreated,
  }: {
    onClose: () => void
    onCreated?: (p: { id: string; name: string }) => void
  }) => (
    <div data-testid="add-project-dialog">
      <button type="button" onClick={onClose} data-testid="add-project-close">
        close
      </button>
      <button
        type="button"
        onClick={() => onCreated?.({ id: 'new-id', name: 'new-project' })}
        data-testid="add-project-create"
      >
        create
      </button>
    </div>
  ),
}))

// 可变项目数据：各用例按需覆盖 state.projects。
const state = vi.hoisted(() => ({
  projects: [{ id: 'p1', name: 'proj', gitBranch: 'main' as string | null }],
}))

vi.mock('../hooks/useSession.js', () => ({
  useProjects: () => ({ data: state.projects }),
}))

afterEach(() => {
  cleanup()
})

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

async function renderWithProvider(node: React.ReactNode) {
  const qc = makeQC()
  const view = render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
  await act(async () => {})
  return view
}

// TopBar 经 useMatched 读路由：覆盖全部可达路径，点击导航（如看板/设置跳转）
// 在内存路由内仍命中同一 TestView。
const testRoutes = createRoutes({
  children: [
    { path: '/', component: () => TestView },
    { path: '/settings', component: () => TestView },
    { path: '/projects/:projectId', component: () => TestView },
    { path: '/projects/:projectId/sessions/:sessionId', component: () => TestView },
    { path: '/projects/:projectId/kanban', component: () => TestView },
    { path: '/projects/:projectId/settings', component: () => TestView },
  ],
})

function TestView() {
  return <TopBar />
}

async function renderAt(path: string) {
  return await renderWithProvider(
    <MemoryRouter routes={testRoutes} initialEntries={[path]}>
      <View />
    </MemoryRouter>,
  )
}

/** 项目上下文下渲染 TopBar：需匹配项目路由以让 useMatched 解析 projectId。 */
async function renderAtProject(projectId: string) {
  return renderAt(`/projects/${projectId}`)
}

/**
 * 未命中路由时渲染 TopBar：生产里由 HistoryRouter 的 notFound 属性提交
 * （App.tsx），TopBar 位于匹配链之外、useMatched 返回 undefined、routePath
 * 为空串。notFound 属于 router 而非 View，放 HistoryRouter 上。
 */
async function renderNotFound(path: string) {
  return await renderWithProvider(
    <MemoryRouter routes={testRoutes} initialEntries={[path]} notFound={<TopBar />}>
      <View />
    </MemoryRouter>,
  )
}

/** 当前被标为「当前页」的导航项文案（aria-current='page'）。 */
function currentNavLabel(): string | null {
  const el = document.querySelector('header nav a[aria-current="page"]')
  return el ? el.textContent.trim() : null
}

describe('TopBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.projects = [{ id: 'p1', name: 'proj', gitBranch: 'main' }]
  })

  it('渲染品牌与导航入口', async () => {
    await renderAt('/')
    expect(screen.getByText('c0de-agent')).toBeTruthy()
    expect(screen.getByText('会话')).toBeTruthy()
    expect(screen.getByText('设置')).toBeTruthy()
  })

  it('设置页可导航（设置链接存在且带 href）', async () => {
    await renderAt('/')
    const settingsLink = screen.getByText('设置').closest('a')
    expect(settingsLink).toBeTruthy()
    expect(settingsLink?.getAttribute('href')).toBe('/settings')
  })

  it('在设置路由时高亮设置入口', async () => {
    await renderAt('/settings')
    const settingsLink = screen.getByText('设置').closest('a')
    expect(settingsLink?.getAttribute('data-active')).not.toBeUndefined()
  })

  it('无项目上下文时会话入口指向根路径', async () => {
    await renderAt('/settings')
    const sessionsLink = screen.getByText('会话').closest('a')
    expect(sessionsLink?.getAttribute('href')).toBe('/')
  })

  it('项目上下文时会话入口指向当前项目路由', async () => {
    await renderAtProject('abc123')
    const sessionsLink = screen.getByText('会话').closest('a')
    expect(sessionsLink?.getAttribute('href')).toBe('/projects/abc123')
  })

  /*
   * 看板入口没有「回根路径」这条退路：RootRedirect 把 / 解析成项目的**会话**
   * 页面，于是无路由 projectId 时（/settings 根路由、404 页）点「项目看板」
   * 会落到会话列表——顶栏写着看板、落点是会话，中间没有任何提示。实测修复前
   * 在 /settings 点它，URL 变成 /projects/<id>。改为解析「当前项目」后指向
   * 真正的看板路由（与 RootRedirect 同一 queryKey，命中缓存不额外发请求）。
   */
  it('无项目上下文时看板入口解析当前项目，而不是退回会话首页', async () => {
    const { projectAPI } = await import('@/services/project.js')
    ;(projectAPI.current as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'abc123',
      name: 'proj',
    })

    await renderAt('/settings')

    await waitFor(() => {
      expect(screen.getByTestId('nav-kanban').getAttribute('href')).toBe('/projects/abc123/kanban')
    })
  })

  it('当前项目解析不出来时看板入口退回根路径（与修复前一致）', async () => {
    const { projectAPI } = await import('@/services/project.js')
    ;(projectAPI.current as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('请在项目目录启动 c0de serve'),
    )

    await renderAt('/settings')

    // 等查询落定：解析失败不得改变落点，更不能渲染成看板路由
    await waitFor(() => {
      expect(projectAPI.current).toHaveBeenCalled()
    })
    expect(screen.getByTestId('nav-kanban').getAttribute('href')).toBe('/')
  })

  /*
   * 导航项的高亮此前只有 data-active + CSS 类，读屏拿不到「你在哪一页」。
   * aria-current='page' 是这件事的标准表达（WCAG 3.2.3 的反向信息）。
   */
  it('当前导航项以 aria-current=page 暴露，且同一时刻只有一项', async () => {
    await renderAt('/settings')
    expect(currentNavLabel()).toBe('设置')

    cleanup()

    await renderAtProject('abc123')
    expect(currentNavLabel()).toBe('会话')

    cleanup()

    await renderAt('/projects/abc123/kanban')
    expect(currentNavLabel()).toBe('项目看板')

    expect(document.querySelectorAll('header nav a[aria-current="page"]').length).toBe(1)
  })

  // 404 视图在匹配链之外渲染 TopBar：屏幕上没有会话页，却把「会话」标成
  // 当前页会让视觉与读屏一起说「你在会话页」。
  it('未命中路由时没有任何导航项被标成当前页', async () => {
    await renderNotFound('/no-such-page')

    expect(screen.getByTestId('nav-kanban')).toBeTruthy()
    expect(currentNavLabel()).toBeNull()
    expect(screen.getByText('会话').closest('a')?.getAttribute('data-active')).toBeNull()
  })

  // ---- ProjectIndicator（内嵌在 TopBar）----

  it('项目上下文时显示项目名与分支', async () => {
    state.projects = [{ id: 'p1', name: 'my-app', gitBranch: 'develop' }]
    await renderAtProject('p1')

    await waitFor(() => {
      expect(screen.getByText('my-app')).toBeTruthy()
    })
    expect(screen.getByTestId('project-branch').textContent).toContain('develop')
  })

  // 复现：触发器的边框/背景/padding/hover 曾挂在 <button> 内的 <span> 上，
  // 按钮自身是 padding:0 的裸容器——实测分支触发器按钮 68x22、描边 0px none，
  // 点击区小于视觉框，且 hover 高亮落在不可点的子元素上。
  // 契约：视觉样式落在真实 button 上，内层只剩排版（纯样式断言交浏览器实测）。
  it('项目/分支触发器的视觉框就是可点按钮本身', async () => {
    state.projects = [{ id: 'p1', name: 'my-app', gitBranch: 'develop' }]
    await renderAtProject('p1')

    await waitFor(() => expect(screen.getByTestId('project-branch')).toBeTruthy())

    for (const testid of ['project-dropdown-trigger', 'project-branch']) {
      const inner = screen.getByTestId(testid)
      // 触发器内容必须包在 button 里，而不是浮在一个无样式的 span 上
      const triggerBtn = inner.closest('button') as HTMLElement | null
      expect(triggerBtn).not.toBeNull()
      expect(triggerBtn?.contains(inner)).toBe(true)
    }
  })

  it('无项目上下文时不渲染项目指示器', async () => {
    await renderAt('/')
    expect(screen.queryByTestId('project-indicator')).toBeNull()
  })

  it('hover 分支名 title 展示最后一次提交 message', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitLastCommit as ReturnType<typeof vi.fn>).mockResolvedValue({
      commit: {
        subject: 'feat: add login page',
        hash: 'abc1234',
        author: 'Alice',
        date: '2 hours ago',
      },
    })

    await renderAtProject('p1')
    await waitFor(() => {
      const label = screen.getByTestId('project-branch')
      expect(label.getAttribute('title')).toContain('feat: add login page')
      expect(label.getAttribute('title')).toContain('abc1234')
    })
  })

  it('无提交记录时分支名 title 不展示', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitLastCommit as ReturnType<typeof vi.fn>).mockResolvedValue({ commit: null })

    await renderAtProject('p1')
    await waitFor(() => {
      expect(screen.getByTestId('project-branch').textContent).toContain('main')
    })
    expect(screen.getByTestId('project-branch').getAttribute('title')).toBeNull()
  })

  it('无 git 分支时不渲染分支标签', async () => {
    state.projects = [{ id: 'p1', name: 'proj', gitBranch: null }]
    await renderAtProject('p1')

    await waitFor(() => {
      expect(screen.getByText('proj')).toBeTruthy()
    })
    expect(screen.queryByTestId('project-branch')).toBeNull()
  })

  // ---- 项目下拉切换 ----

  it('点击项目名展开下拉，列出所有项目', async () => {
    state.projects = [
      { id: 'p1', name: 'proj-a', gitBranch: 'main' },
      { id: 'p2', name: 'proj-b', gitBranch: 'develop' },
    ]
    await renderAtProject('p1')

    // 下拉未打开时看不到 proj-b
    expect(screen.queryByText('proj-b')).toBeNull()

    fireEvent.click(screen.getByTestId('project-dropdown-trigger'))

    await waitFor(() => {
      expect(screen.getByText('proj-b')).toBeTruthy()
    })
    // 当前项目有 ✓
    expect(screen.getByTestId('project-dropdown-item-p1').textContent).toContain('\u2713')
  })

  it('点击下拉中的项目导航到该项目的路由', async () => {
    state.projects = [
      { id: 'p1', name: 'proj-a', gitBranch: 'main' },
      { id: 'p2', name: 'proj-b', gitBranch: 'develop' },
    ]
    await renderAtProject('p1')

    fireEvent.click(screen.getByTestId('project-dropdown-trigger'))
    await waitFor(() => {
      expect(screen.getByTestId('project-dropdown-item-p2')).toBeTruthy()
    })

    // 点击后 URL 变化（MemoryRouter 内）
    fireEvent.click(screen.getByTestId('project-dropdown-item-p2'))

    // 导航后面板关闭、proj-b 成为当前项目（SessionList 路由跳转由 useParams 驱动）
    await waitFor(() => {
      expect(screen.queryByTestId('project-dropdown-item-p2')).toBeNull()
    })
  })

  it('点击"添加项目"打开对话框', async () => {
    await renderAtProject('p1')

    fireEvent.click(screen.getByTestId('project-dropdown-trigger'))
    await waitFor(() => {
      expect(screen.getByTestId('project-dropdown-add')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('project-dropdown-add'))
    expect(screen.getByTestId('add-project-dialog')).toBeTruthy()
  })

  // ---- 分支下拉切换 ----

  it('点击分支名展开下拉，列出本地分支', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitBranches as ReturnType<typeof vi.fn>).mockResolvedValue({
      branches: [
        { name: 'main', current: true, lastSubject: 'init' },
        { name: 'develop', current: false, lastSubject: 'wip' },
      ],
    })

    await renderAtProject('p1')
    fireEvent.click(screen.getByTestId('branch-dropdown-trigger'))

    await waitFor(() => {
      expect(screen.getByTestId('branch-dropdown-item-develop')).toBeTruthy()
    })
    // 当前分支有 ✓
    expect(screen.getByTestId('branch-dropdown-item-main').textContent).toContain('\u2713')
  })

  it('点击非当前分支调用 gitCheckout API', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitBranches as ReturnType<typeof vi.fn>).mockResolvedValue({
      branches: [
        { name: 'main', current: true, lastSubject: null },
        { name: 'develop', current: false, lastSubject: null },
      ],
    })

    await renderAtProject('p1')
    fireEvent.click(screen.getByTestId('branch-dropdown-trigger'))

    await waitFor(() => {
      expect(screen.getByTestId('branch-dropdown-item-develop')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('branch-dropdown-item-develop'))

    await waitFor(() => {
      expect(fileAPI.gitCheckout).toHaveBeenCalledWith('p1', 'develop')
    })
  })

  it('当前分支项 disabled 不可点击', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitBranches as ReturnType<typeof vi.fn>).mockResolvedValue({
      branches: [{ name: 'main', current: true, lastSubject: null }],
    })

    await renderAtProject('p1')
    fireEvent.click(screen.getByTestId('branch-dropdown-trigger'))

    await waitFor(() => {
      expect(screen.getByTestId('branch-dropdown-item-main')).toBeTruthy()
    })
    // testid 现在落在菜单项按钮内的内容行 span 上，向上取按钮断言 disabled
    const item = screen
      .getByTestId('branch-dropdown-item-main')
      .closest('button') as HTMLButtonElement
    expect(item.disabled).toBe(true)
  })

  it('输入新分支名并 Enter 调用 gitBranchCreate API', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitBranches as ReturnType<typeof vi.fn>).mockResolvedValue({
      branches: [{ name: 'main', current: true, lastSubject: null }],
    })

    await renderAtProject('p1')
    fireEvent.click(screen.getByTestId('branch-dropdown-trigger'))

    await waitFor(() => {
      expect(screen.getByTestId('branch-new-input')).toBeTruthy()
    })

    const input = screen.getByTestId('branch-new-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'feature/x' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(fileAPI.gitBranchCreate).toHaveBeenCalledWith('p1', 'feature/x')
    })
    // 成功后才清空：输入框复位，等待下一次输入。
    await waitFor(() => {
      expect((screen.getByTestId('branch-new-input') as HTMLInputElement).value).toBe('')
    })
  })

  // 回归：submit 曾无条件 setName('')，创建失败（分支已存在 / 非法 ref /
  // worktree 被占用）时输入框已被清空，用户只能照着错误文案把刚打的名字重敲一遍。
  it('创建分支失败时保留输入的分支名并就地报出原因', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitBranches as ReturnType<typeof vi.fn>).mockResolvedValue({
      branches: [{ name: 'main', current: true, lastSubject: null }],
    })
    const gitBranchCreate = fileAPI.gitBranchCreate as ReturnType<typeof vi.fn>
    gitBranchCreate.mockRejectedValueOnce(new Error("branch 'feature/x' already exists"))

    await renderAtProject('p1')
    fireEvent.click(screen.getByTestId('branch-dropdown-trigger'))

    await waitFor(() => {
      expect(screen.getByTestId('branch-new-input')).toBeTruthy()
    })

    const input = screen.getByTestId('branch-new-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'feature/x' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const err = await screen.findByTestId('branch-create-error')
    expect(err.textContent).toContain('already exists')
    expect(err.getAttribute('role')).toBe('alert')
    expect(input.value).toBe('feature/x')
    // 允许改完再试一次。
    expect(input.disabled).toBe(false)
  })

  // ---- CommitButton（内嵌在 TopBar via ProjectIndicator actions）----

  it('无变更时提交按钮 disabled 且不高亮', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await renderAtProject('p1')
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn')).toBeInTheDocument()
    })
    const btn = screen.getByTestId('git-commit-btn') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('data-has-changes')).toBeNull()
  })

  // 读不到 git status（5xx / 项目已删除 404）此前与「确实没有变更」共用同一条路径：
  // 按钮禁用、title 写死「无变更」——有未提交改动的用户被告知没有变更，且唯一的
  // 提交入口还是灰的，没有任何重试手段。契约：失败态可点且点了重试读取，不提交。
  it('git-status 读取失败时不谎报「无变更」：按钮可点、点了重试而非提交', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('git boom'))

    await renderAtProject('p1')
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').getAttribute('data-git-status-failed')).toBe(
        'true',
      )
    })
    const btn = screen.getByTestId('git-commit-btn') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    // 未提交：点击是重试读取
    fireEvent.click(btn)
    await waitFor(() => expect(fileAPI.gitStatus).toHaveBeenCalledTimes(2))
    expect(fileAPI.gitCommit).not.toHaveBeenCalled()
  })

  it('有未提交变更时提交按钮高亮（data-has-changes）', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
      'bar.ts': 'untracked',
    })

    await renderAtProject('p1')
    await waitFor(() => {
      const btn = screen.getByTestId('git-commit-btn')
      expect(btn.getAttribute('data-has-changes')).toBe('true')
    })
    const btn = screen.getByTestId('git-commit-btn') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('只有 ignored 文件时提交按钮不高亮', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'node_modules/x.js': 'ignored',
    })

    await renderAtProject('p1')
    await waitFor(() => {
      const btn = screen.getByTestId('git-commit-btn')
      expect(btn.getAttribute('data-has-changes')).toBeNull()
    })
  })

  it('点击提交按钮调用 gitCommit API', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
    })
    ;(fileAPI.gitCommit as ReturnType<typeof vi.fn>).mockResolvedValue({
      committed: true,
      message: 'feat: update foo',
      hash: 'abc123',
      fileCount: 1,
    })

    await renderAtProject('p1')
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').getAttribute('data-has-changes')).toBe('true')
    })

    fireEvent.click(screen.getByTestId('git-commit-btn'))

    await waitFor(() => {
      expect(fileAPI.gitCommit).toHaveBeenCalledWith('p1', undefined)
    })
    // 成功后显示 ✓
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').textContent).toContain('已提交')
    })
  })

  it('提交失败时显示错误状态', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
    })
    ;(fileAPI.gitCommit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LLM error'))

    await renderAtProject('p1')
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').getAttribute('data-has-changes')).toBe('true')
    })

    fireEvent.click(screen.getByTestId('git-commit-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').textContent).toContain('提交失败')
    })
  })

  it('LLM 检测到可疑文件时弹审查框，选「仍然提交」后调用 force 模式', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
    })
    // 第一次调用返回 needsReview
    ;(fileAPI.gitCommit as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        needsReview: true,
        message: 'feat: add config',
        suggestions: ['.env'],
      })
      .mockResolvedValueOnce({
        committed: true,
        message: 'feat: add config',
        hash: 'abc123',
        fileCount: 2,
      })

    await renderAtProject('p1')
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').getAttribute('data-has-changes')).toBe('true')
    })

    fireEvent.click(screen.getByTestId('git-commit-btn'))

    // 弹出审查框
    await waitFor(() => {
      expect(screen.getByTestId('commit-review-dialog')).toBeInTheDocument()
    })
    expect(screen.getByText('.env')).toBeInTheDocument()

    // 选「仍然提交」
    fireEvent.click(screen.getByTestId('commit-review-force'))

    // 第二次调用使用 force 模式
    await waitFor(() => {
      expect(fileAPI.gitCommit).toHaveBeenNthCalledWith(2, 'p1', {
        mode: 'force',
        message: 'feat: add config',
      })
    })
    // 弹框关闭，显示成功
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').textContent).toContain('已提交')
    })
  })

  it('LLM 检测到可疑文件时选「加入 .gitignore」调用 append-ignore 模式', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
    })
    ;(fileAPI.gitCommit as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        needsReview: true,
        message: 'feat: add feature',
        suggestions: ['.env', 'dist/'],
      })
      .mockResolvedValueOnce({
        committed: true,
        message: 'feat: add feature',
        hash: 'def456',
        fileCount: 3,
      })

    await renderAtProject('p1')
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').getAttribute('data-has-changes')).toBe('true')
    })

    fireEvent.click(screen.getByTestId('git-commit-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('commit-review-dialog')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('commit-review-ignore'))

    await waitFor(() => {
      expect(fileAPI.gitCommit).toHaveBeenNthCalledWith(2, 'p1', {
        mode: 'append-ignore',
        message: 'feat: add feature',
        suggestions: ['.env', 'dist/'],
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').textContent).toContain('已提交')
    })
  })

  it('审查框选「取消」关闭弹框不提交', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
    })
    ;(fileAPI.gitCommit as ReturnType<typeof vi.fn>).mockResolvedValue({
      needsReview: true,
      message: 'feat: x',
      suggestions: ['.env'],
    })

    await renderAtProject('p1')
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').getAttribute('data-has-changes')).toBe('true')
    })

    fireEvent.click(screen.getByTestId('git-commit-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('commit-review-dialog')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('commit-review-cancel'))

    // 弹框消失
    await waitFor(() => {
      expect(screen.queryByTestId('commit-review-dialog')).toBeNull()
    })
    // gitCommit 只被调用了一次（初始调用），没有第二次
    expect(fileAPI.gitCommit).toHaveBeenCalledTimes(1)
  })
})

describe('TopBar — 月成本徽标', () => {
  it('成本按十进制舍入展示（1.005 → $1.01，不显示 $1.00）', async () => {
    const { usageAPI } = await import('@/services/usage.js')
    ;(usageAPI.summary as Mock).mockResolvedValue({
      priceCatalogVersion: 'test',
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cost: 1.005,
        unknownCostCalls: 0,
        calls: 1,
      },
      currentMonth: {
        key: '2026-09',
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cost: 1.005,
        unknownCostCalls: 0,
        calls: 1,
      },
      byMonth: [],
      byModel: [],
    })

    await renderAt('/')
    const badge = await screen.findByTestId('month-cost-badge')
    expect(badge.textContent).toBe('本月 $1.01')
  })

  // 回归：用量查询失败时 data 为 undefined，cost 回落 0，徽标照常渲染成
  // 「本月 $0.00」——一个精确、可信、且完全错误的数字。用户会据此认为本月没
  // 花钱、没超预算。读不到必须说读不到。
  it('用量读取失败时徽标显示不可用，不谎报 $0.00', async () => {
    const { usageAPI } = await import('@/services/usage.js')
    ;(usageAPI.summary as Mock).mockRejectedValue(new Error('usage summary 500'))

    await renderAt('/')
    const badge = await screen.findByTestId('month-cost-badge')
    await waitFor(() => {
      expect(badge.textContent).toContain('用量不可用')
    })
    expect(badge.textContent).not.toContain('$0')
  })
})

/**
 * 回归：分支切换失败（git checkout 被未提交改动拒绝）时页面完全无提示。
 *
 * 缺陷：checkoutMut 此前没有 onError，错误只写进 mutation state。点分支项后
 * 下拉立即关闭，页面什么都不剩——用户以为已切到目标分支，后续 agent 的编辑与
 * 提交全部落到旧分支。对照：同菜单的新建分支 NewBranchForm 有 error 渲染，
 * 说明这是漏写而非设计。
 */
describe('TopBar — 分支切换失败提示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.projects = [{ id: 'p1', name: 'proj', gitBranch: 'main' }]
  })

  it('gitCheckout 失败时在顶栏显示原因，并说清「仍在原分支」', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitBranches as ReturnType<typeof vi.fn>).mockResolvedValue({
      branches: [
        { name: 'main', current: true, lastSubject: null },
        { name: 'develop', current: false, lastSubject: null },
      ],
    })
    ;(fileAPI.gitCheckout as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      message: 'Your local changes would be overwritten by checkout',
    })

    state.projects = [{ id: 'p1', name: 'proj', gitBranch: 'main' }]
    await renderAtProject('p1')
    fireEvent.click(screen.getByTestId('branch-dropdown-trigger'))
    await waitFor(() => {
      expect(screen.getByTestId('branch-dropdown-item-develop')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('branch-dropdown-item-develop'))

    const err = await screen.findByTestId('branch-checkout-error')
    expect(err.textContent).toContain('未能切到该分支')
    expect(err.textContent).toContain('Your local changes would be overwritten')
    // 分支标签仍显示原分支，且错误提示随它一起留在顶栏（不藏进已关闭的下拉）
    expect(screen.getByTestId('project-branch').textContent).toContain('main')
    expect(err.getAttribute('title')).toContain('main')
  })

  it('下一次切换成功后清除错误提示', async () => {
    const { fileAPI } = await import('@/services/file.js')
    ;(fileAPI.gitBranches as ReturnType<typeof vi.fn>).mockResolvedValue({
      branches: [
        { name: 'main', current: true, lastSubject: null },
        { name: 'develop', current: false, lastSubject: null },
      ],
    })
    ;(fileAPI.gitCheckout as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce({ message: 'checkout failed' })
      .mockResolvedValueOnce({ branch: 'develop' })

    state.projects = [{ id: 'p1', name: 'proj', gitBranch: 'main' }]
    await renderAtProject('p1')
    fireEvent.click(screen.getByTestId('branch-dropdown-trigger'))
    await waitFor(() => {
      expect(screen.getByTestId('branch-dropdown-item-develop')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('branch-dropdown-item-develop'))
    await screen.findByTestId('branch-checkout-error')

    fireEvent.click(screen.getByTestId('branch-dropdown-trigger'))
    await waitFor(() => {
      expect(screen.getByTestId('branch-dropdown-item-develop')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('branch-dropdown-item-develop'))

    await waitFor(() => {
      expect(screen.queryByTestId('branch-checkout-error')).toBeNull()
    })
  })
})

describe('TopBar — 删除项目失败提示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.projects = [{ id: 'p1', name: 'proj', gitBranch: 'main' }]
  })

  // 回归：删除失败时原因被写进项目下拉里，而确认弹层在请求发出前就关掉了、
  // 下拉也已关闭卸载——用户看到的是「点了删除，什么也没发生」，还可能反复点。
  // 现在弹层留在原地，原因与操作同框（role=alert 播报）。
  it('删除被 409 拒绝时弹层不关闭，原因为可见的 alert', async () => {
    const { projectAPI } = await import('@/services/project.js')
    ;(projectAPI.remove as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('项目下有 1 个打开的终端，请先关闭终端后再删除项目'),
    )

    await renderAtProject('p1')
    fireEvent.click(screen.getByTestId('project-dropdown-trigger'))
    await waitFor(() => expect(screen.getByTestId('delete-project')).toBeTruthy())
    fireEvent.click(screen.getByTestId('delete-project'))

    const input = await screen.findByTestId('danger-confirm-input')
    fireEvent.change(input, { target: { value: 'proj' } })
    fireEvent.click(screen.getByTestId('danger-confirm-btn'))

    const alert = await screen.findByTestId('danger-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain('打开的终端')
    // 弹层仍在（用户还站在删除这一步上，项目当然也还在）
    expect(screen.getByTestId('danger-confirm-dialog')).toBeTruthy()
    expect(screen.getByTestId('project-indicator')).toBeTruthy()
  })
})
