// TopBar 组件测试，对应 src/web/components/TopBar.tsx
// TopBar 内嵌 ProjectIndicator（项目名/分支可下拉切换 + 添加按钮）+ CommitButton（提交按钮）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TopBar } from './TopBar.js'

// ---- mocks ----
vi.mock('../services/file.js', () => ({
  fileAPI: {
    gitStatus: vi.fn().mockResolvedValue({}),
    gitCommit: vi.fn(),
    gitLastCommit: vi.fn().mockResolvedValue({ commit: null }),
    gitBranches: vi.fn().mockResolvedValue({ branches: [] }),
    gitCheckout: vi.fn().mockResolvedValue({ branch: 'main' }),
    gitBranchCreate: vi.fn().mockResolvedValue({ branch: 'new-branch' }),
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

function renderWithProvider(node: React.ReactNode) {
  const qc = makeQC()
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function renderAt(path: string) {
  return renderWithProvider(
    <MemoryRouter initialEntries={[path]}>
      <TopBar />
    </MemoryRouter>,
  )
}

/** 项目上下文下渲染 TopBar：需匹配项目路由以让 useParams 解析 projectId。 */
function renderAtProject(projectId: string) {
  return renderWithProvider(
    <MemoryRouter initialEntries={[`/projects/${projectId}`]}>
      <Routes>
        <Route path="/projects/:projectId" element={<TopBar />} />
        <Route path="/projects/:projectId/*" element={<TopBar />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('TopBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.projects = [{ id: 'p1', name: 'proj', gitBranch: 'main' }]
  })

  it('渲染品牌与导航入口', () => {
    renderAt('/')
    expect(screen.getByText('c0de-agent')).toBeTruthy()
    expect(screen.getByText('会话')).toBeTruthy()
    expect(screen.getByText('设置')).toBeTruthy()
  })

  it('设置页可导航（设置链接存在且带 href）', () => {
    renderAt('/')
    const settingsLink = screen.getByText('设置').closest('a')
    expect(settingsLink).toBeTruthy()
    expect(settingsLink?.getAttribute('href')).toBe('/settings')
  })

  it('在设置路由时高亮设置入口', () => {
    renderAt('/settings')
    const settingsLink = screen.getByText('设置').closest('a')
    expect(settingsLink?.getAttribute('data-active')).not.toBeUndefined()
  })

  it('无项目上下文时会话入口指向根路径', () => {
    renderAt('/settings')
    const sessionsLink = screen.getByText('会话').closest('a')
    expect(sessionsLink?.getAttribute('href')).toBe('/')
  })

  it('项目上下文时会话入口指向当前项目路由', () => {
    renderAtProject('abc123')
    const sessionsLink = screen.getByText('会话').closest('a')
    expect(sessionsLink?.getAttribute('href')).toBe('/projects/abc123')
  })

  // ---- ProjectIndicator（内嵌在 TopBar）----

  it('项目上下文时显示项目名与分支', async () => {
    state.projects = [{ id: 'p1', name: 'my-app', gitBranch: 'develop' }]
    renderAtProject('p1')

    await waitFor(() => {
      expect(screen.getByText('my-app')).toBeTruthy()
    })
    expect(screen.getByTestId('project-branch').textContent).toContain('develop')
  })

  it('无项目上下文时不渲染项目指示器', () => {
    renderAt('/')
    expect(screen.queryByTestId('project-indicator')).toBeNull()
  })

  it('hover 分支名 title 展示最后一次提交 message', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.gitLastCommit as ReturnType<typeof vi.fn>).mockResolvedValue({
      commit: {
        subject: 'feat: add login page',
        hash: 'abc1234',
        author: 'Alice',
        date: '2 hours ago',
      },
    })

    renderAtProject('p1')
    await waitFor(() => {
      const label = screen.getByTestId('project-branch')
      expect(label.getAttribute('title')).toContain('feat: add login page')
      expect(label.getAttribute('title')).toContain('abc1234')
    })
  })

  it('无提交记录时分支名 title 不展示', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.gitLastCommit as ReturnType<typeof vi.fn>).mockResolvedValue({ commit: null })

    renderAtProject('p1')
    await waitFor(() => {
      expect(screen.getByTestId('project-branch').textContent).toContain('main')
    })
    expect(screen.getByTestId('project-branch').getAttribute('title')).toBeNull()
  })

  it('无 git 分支时不渲染分支标签', async () => {
    state.projects = [{ id: 'p1', name: 'proj', gitBranch: null }]
    renderAtProject('p1')

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
    renderAtProject('p1')

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
    renderAtProject('p1')

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
    renderAtProject('p1')

    fireEvent.click(screen.getByTestId('project-dropdown-trigger'))
    await waitFor(() => {
      expect(screen.getByTestId('project-dropdown-add')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('project-dropdown-add'))
    expect(screen.getByTestId('add-project-dialog')).toBeTruthy()
  })

  // ---- 分支下拉切换 ----

  it('点击分支名展开下拉，列出本地分支', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.gitBranches as ReturnType<typeof vi.fn>).mockResolvedValue({
      branches: [
        { name: 'main', current: true, lastSubject: 'init' },
        { name: 'develop', current: false, lastSubject: 'wip' },
      ],
    })

    renderAtProject('p1')
    fireEvent.click(screen.getByTestId('branch-dropdown-trigger'))

    await waitFor(() => {
      expect(screen.getByTestId('branch-dropdown-item-develop')).toBeTruthy()
    })
    // 当前分支有 ✓
    expect(screen.getByTestId('branch-dropdown-item-main').textContent).toContain('\u2713')
  })

  it('点击非当前分支调用 gitCheckout API', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.gitBranches as ReturnType<typeof vi.fn>).mockResolvedValue({
      branches: [
        { name: 'main', current: true, lastSubject: null },
        { name: 'develop', current: false, lastSubject: null },
      ],
    })

    renderAtProject('p1')
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
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.gitBranches as ReturnType<typeof vi.fn>).mockResolvedValue({
      branches: [{ name: 'main', current: true, lastSubject: null }],
    })

    renderAtProject('p1')
    fireEvent.click(screen.getByTestId('branch-dropdown-trigger'))

    await waitFor(() => {
      expect(screen.getByTestId('branch-dropdown-item-main')).toBeTruthy()
    })
    const item = screen.getByTestId('branch-dropdown-item-main') as HTMLButtonElement
    expect(item.disabled).toBe(true)
  })

  it('输入新分支名并 Enter 调用 gitBranchCreate API', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.gitBranches as ReturnType<typeof vi.fn>).mockResolvedValue({
      branches: [{ name: 'main', current: true, lastSubject: null }],
    })

    renderAtProject('p1')
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
  })

  // ---- CommitButton（内嵌在 TopBar via ProjectIndicator actions）----

  it('无变更时提交按钮 disabled 且不高亮', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({})

    renderAtProject('p1')
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn')).toBeInTheDocument()
    })
    const btn = screen.getByTestId('git-commit-btn') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('data-has-changes')).toBeNull()
  })

  it('有未提交变更时提交按钮高亮（data-has-changes）', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
      'bar.ts': 'untracked',
    })

    renderAtProject('p1')
    await waitFor(() => {
      const btn = screen.getByTestId('git-commit-btn')
      expect(btn.getAttribute('data-has-changes')).toBe('true')
    })
    const btn = screen.getByTestId('git-commit-btn') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('只有 ignored 文件时提交按钮不高亮', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'node_modules/x.js': 'ignored',
    })

    renderAtProject('p1')
    await waitFor(() => {
      const btn = screen.getByTestId('git-commit-btn')
      expect(btn.getAttribute('data-has-changes')).toBeNull()
    })
  })

  it('点击提交按钮调用 gitCommit API', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
    })
    ;(fileAPI.gitCommit as ReturnType<typeof vi.fn>).mockResolvedValue({
      committed: true,
      message: 'feat: update foo',
      hash: 'abc123',
      fileCount: 1,
    })

    renderAtProject('p1')
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
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
    })
    ;(fileAPI.gitCommit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LLM error'))

    renderAtProject('p1')
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').getAttribute('data-has-changes')).toBe('true')
    })

    fireEvent.click(screen.getByTestId('git-commit-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').textContent).toContain('提交失败')
    })
  })

  it('LLM 检测到可疑文件时弹审查框，选「仍然提交」后调用 force 模式', async () => {
    const { fileAPI } = await import('../services/file.js')
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

    renderAtProject('p1')
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
    const { fileAPI } = await import('../services/file.js')
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

    renderAtProject('p1')
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
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
    })
    ;(fileAPI.gitCommit as ReturnType<typeof vi.fn>).mockResolvedValue({
      needsReview: true,
      message: 'feat: x',
      suggestions: ['.env'],
    })

    renderAtProject('p1')
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
