// ChatPage 组件测试，对应 src/web/views/ChatPage.tsx
// 覆盖项目作用域本地 state（预览面板选中文件）在切项目时的重置。

import { createRoutes, MemoryRouter, View } from '@native-router/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectAPI } from '@/services/project.js'
import { ChatPage } from '@/views/ChatPage.js'

// ---- mocks ----
// 同级重组件与本用例要观察的契约无关，全部换成桩；Layout 用真件（预览面板的落点）。
vi.mock('@/components/TopBar.js', () => ({ TopBar: () => null }))
vi.mock('@/components/TerminalPanel.js', () => ({
  TerminalPanel: ({ cwd, cwdLoadError }: { cwd?: string; cwdLoadError?: unknown }) => (
    <div>
      <span data-testid="terminal-cwd">{cwd ?? '(无)'}</span>
      {cwdLoadError ? (
        <button
          type="button"
          data-testid="terminal-cwd-retry"
          onClick={() => {
            ;(cwdLoadError as { retry: () => void }).retry()
          }}
        >
          retry
        </button>
      ) : null}
    </div>
  ),
}))
vi.mock('@/views/ChatView.js', () => ({ ChatView: () => null }))
vi.mock('@/views/SessionList.js', () => ({ SessionList: () => null }))
vi.mock('@/views/FilePreview.js', () => ({
  FilePreview: ({ path }: { path: string }) => <div data-testid="preview">{path}</div>,
}))
vi.mock('@/hooks/useTerminal.js', () => ({
  useTerminal: () => ({ open: false, toggleOpen: vi.fn() }),
}))
/** 完整的 Project 形状（新增字段时补齐，勿用字面量残缺对象冒充）。 */
function makeProject(id = 'p1') {
  return {
    id,
    name: `项目 ${id}`,
    worktree: '/tmp/demo',
    vcs: 'git' as const,
    gitRemote: null,
    gitBranch: 'main',
    createdAt: 1,
    updatedAt: 1,
  }
}

vi.mock('@/services/project.js', () => ({
  projectAPI: {
    get: vi.fn(async (id: string) => ({
      id,
      name: `项目 ${id}`,
      worktree: '/tmp/demo',
      vcs: 'git' as const,
      gitRemote: null,
      gitBranch: 'main',
      createdAt: 1,
      updatedAt: 1,
    })),
  },
}))

/**
 * 文件树桩：把两条真实入口暴露成按钮——onPick（真实 FileBrowser 点文件时调它）
 * 与「切项目 / 切会话」（真实应用里由顶栏项目下拉、会话列表发起，都是同一台路由的导航）。
 */
vi.mock('@/views/FileBrowser.js', async () => {
  const { useRouter } = await import('@native-router/react')
  const { navigateTo } = await import('@/navigateTo.js')
  return {
    FileBrowser: ({ onPick }: { onPick: (path: string) => void }) => {
      const router = useRouter()
      return (
        <div>
          <button type="button" data-testid="pick-file" onClick={() => onPick('src/app.ts')}>
            pick
          </button>
          <button
            type="button"
            data-testid="switch-project"
            onClick={() =>
              navigateTo(router, '/projects/:projectId', { params: { projectId: 'p2' } })
            }
          >
            switch project
          </button>
          <button
            type="button"
            data-testid="switch-session"
            onClick={() =>
              navigateTo(router, '/projects/:projectId/sessions/:sessionId', {
                params: { projectId: 'p1', sessionId: 's2' },
              })
            }
          >
            switch session
          </button>
        </div>
      )
    },
  }
})

// Layout 会渲染 MobileNav/Workbench，需要 Router 上下文；用真路由表承载 ChatPage，
// 两条 path 与 App 一致（草稿页 / 会话页）。
const testRoutes = createRoutes({
  children: [
    { path: '/projects/:projectId', component: () => ChatPage },
    { path: '/projects/:projectId/sessions/:sessionId', component: () => ChatPage },
  ],
})

async function renderAt(entry: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter routes={testRoutes} initialEntries={[entry]}>
        <View />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  // native-router 的 View 在 effect 里才解析出路由视图，首帧断言前必须冲一次
  await act(async () => {})
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

/**
 * 回归：切项目后预览面板仍挂着上一个项目的文件。
 *
 * ChatPage 对 /projects/:projectId 复用同一组件实例，换 param 不重挂载——
 * selectedFile 是**相对路径**，预览按最新 projectId 重新读取，于是「我在看
 * A 的 src/app.ts」会被静默换成 B 的同名文件（实测路径不变、内容变成 B 的）。
 */
describe('ChatPage 切项目', () => {
  it('收起预览面板，不再显示上一个项目的文件', async () => {
    await renderAt('/projects/p1')

    // 侧栏默认在「会话」页签，文件树要切过去才挂载（真实用法一致）
    fireEvent.click(screen.getByTestId('tab-files'))
    fireEvent.click(screen.getByTestId('pick-file'))
    await waitFor(() => expect(screen.getByTestId('preview').textContent).toBe('src/app.ts'))

    fireEvent.click(screen.getByTestId('switch-project'))

    await waitFor(() => expect(screen.queryByTestId('preview')).toBeNull())
  })

  it('同项目内换会话不收起预览（面板是项目作用域，不是会话作用域）', async () => {
    await renderAt('/projects/p1/sessions/s1')

    fireEvent.click(screen.getByTestId('tab-files'))
    fireEvent.click(screen.getByTestId('pick-file'))
    await waitFor(() => expect(screen.getByTestId('preview').textContent).toBe('src/app.ts'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('switch-session'))
    })

    expect(screen.getByTestId('preview').textContent).toBe('src/app.ts')
  })
})

/**
 * 回归：项目信息读取失败（GET /api/projects/:id 500）与「还在加载」同形——
 * ChatPage 只解构 data，失败后 project 恒为 undefined，终端面板因此拿不到 cwd，
 * 页面上没有任何区别：既没有原因，也没有重试，面板只剩一个既缺「新建终端」按钮
 * 又什么都不说的「尚无终端」。
 */
describe('ChatPage 项目信息读取失败', () => {
  it('把失败原因与重试交给终端面板，而不是让它默默退回无 cwd', async () => {
    vi.mocked(projectAPI.get).mockRejectedValue(new Error('项目服务暂时不可用'))
    await renderAt('/projects/p1/sessions/s1')

    await waitFor(() => expect(screen.getByTestId('terminal-cwd-retry')).toBeInTheDocument())
    expect(screen.getByTestId('terminal-cwd').textContent).toBe('(无)')

    // 重试入口真的会重新发起读取；恢复正常后面板拿到项目 worktree
    vi.mocked(projectAPI.get).mockResolvedValue({
      ...makeProject(),
      worktree: '/tmp/demo',
    })
    fireEvent.click(screen.getByTestId('terminal-cwd-retry'))
    await waitFor(() => expect(screen.getByTestId('terminal-cwd').textContent).toBe('/tmp/demo'))
    expect(screen.queryByTestId('terminal-cwd-retry')).toBeNull()
  })
})
