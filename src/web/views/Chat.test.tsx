import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineRow } from '../components/session/utils/timeline.js'
import { FileSelectionContext } from '../contexts/FileSelectionContext.js'
import { FileReferenceProvider } from '../contexts/ReferenceContext.js'
import { commandsAPI } from '../services/commands.js'
import { permissionAPI } from '../services/permission.js'
import { workflowsAPI } from '../services/workflows.js'
import { Chat } from './Chat.js'
import { ChatWelcome, EXAMPLE_TASKS } from './ChatView.js'

// Composer 内部 useCommands 会请求 /api/commands；mock 掉避免真实网络调用。
vi.mock('../services/commands.js', () => ({
  commandsAPI: { list: vi.fn().mockResolvedValue({ commands: [] }) },
}))

// Composer 内部 useQuery 会请求 /api/workflows；mock 掉
vi.mock('../services/workflows.js', () => ({
  workflowsAPI: { list: vi.fn().mockResolvedValue({ workflows: [] }) },
}))

vi.mock('../services/permission.js', () => ({
  permissionAPI: {
    getMode: vi.fn().mockResolvedValue({ mode: 'default' }),
    setMode: vi.fn().mockResolvedValue({ mode: 'auto' }),
  },
  broadcastModeChange: vi.fn(),
  subscribeModeChange: vi.fn(() => () => {}),
}))

afterEach(() => cleanup())

function renderChat(overrides: Record<string, unknown> = {}) {
  const handlers = {
    onSend: vi.fn(),
    onAbort: vi.fn(),
    onConfirm: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onSteer: vi.fn(),
  }
  const base = {
    timeline: [] as TimelineRow[],
    isStreaming: true,
    paused: false,
    usage: null,
    pendingPermission: null,
    ...handlers,
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <FileSelectionContext.Provider
        value={{ selectedFile: null, openFile: () => {}, closeFile: () => {} }}
      >
        <Chat {...base} {...overrides} />
      </FileSelectionContext.Provider>
    </QueryClientProvider>,
  )
  return handlers
}

describe('Chat pause/resume/steer controls', () => {
  it('renders a pause button while streaming and not paused', () => {
    const h = renderChat()
    fireEvent.click(screen.getByTestId('pause'))
    expect(h.onPause).toHaveBeenCalledOnce()
  })

  it('renders a resume button when paused', () => {
    const h = renderChat({ paused: true })
    expect(screen.queryByTestId('pause')).toBeNull()
    fireEvent.click(screen.getByTestId('resume'))
    expect(h.onResume).toHaveBeenCalledOnce()
  })

  it('hides pause/resume while idle (not streaming)', () => {
    renderChat({ isStreaming: false })
    expect(screen.queryByTestId('pause')).toBeNull()
    expect(screen.queryByTestId('resume')).toBeNull()
  })

  it('流式态「追加指令」按钮注入 steering 文本，不走 onSend', () => {
    const h = renderChat()
    const editor = screen.getByTestId('composer-editor')
    editor.textContent = 'be concise'
    fireEvent.input(editor)
    fireEvent.click(screen.getByTestId('append'))
    expect(h.onSteer).toHaveBeenCalledWith('be concise')
    expect(h.onSend).not.toHaveBeenCalled()
  })

  it('流式态「发送」按钮变「终止」，点击触发 onAbort', () => {
    const h = renderChat()
    const sendBtn = screen.getByTestId('send')
    expect(sendBtn.textContent).toBe('终止')
    fireEvent.click(sendBtn)
    expect(h.onAbort).toHaveBeenCalledOnce()
  })

  it('非流式态「追加指令」按钮禁用，「发送」可点', () => {
    renderChat({ isStreaming: false })
    expect(screen.getByTestId('append')).toBeDisabled()
    expect(screen.getByTestId('send').textContent).toBe('发送')
  })
})

describe('Chat permission mode toggle', () => {
  it('默认渲染未勾选的自动授权开关，仅显示中性说明', () => {
    renderChat()
    const toggle = screen.getByTestId('permission-mode-toggle') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    // 关闭态：无警示 pill，只有中性说明文本
    expect(screen.queryByTestId('permission-mode-warning')).toBeNull()
    expect(screen.getByTestId('permission-mode-hint').textContent).toBe('工具执行前逐个确认')
  })

  it('点击开关切换到 auto：调用 setMode 并显示警示 pill', () => {
    renderChat()
    fireEvent.click(screen.getByTestId('permission-mode-toggle'))
    expect(vi.mocked(permissionAPI.setMode)).toHaveBeenCalledWith('auto', undefined)
    const warn = screen.getByTestId('permission-mode-warning')
    expect(warn.textContent).toContain('自动授权已开启')
    expect(screen.queryByTestId('permission-mode-hint')).toBeNull()
  })

  it('服务端返回 auto（已保存配置）时默认勾选并显示警示 pill', async () => {
    vi.mocked(permissionAPI.getMode).mockResolvedValueOnce({ mode: 'auto' })
    renderChat()
    const toggle = screen.getByTestId('permission-mode-toggle') as HTMLInputElement
    await waitFor(() => expect(toggle.checked).toBe(true))
    expect(screen.getByTestId('permission-mode-warning').textContent).toContain('自动授权已开启')
  })
})

describe('slash 命令 popover 候选选择', () => {
  // 复现 bug：输入 /c 后 popover 过滤显示 [clear, config, compact]，
  // 但旧代码 Enter 用全列表索引选 commands[0]=help（错误）。修复后应选高亮项。
  const TEST_COMMANDS = [
    { name: 'help', description: 'List available slash commands' },
    { name: 'compact', description: 'Manually trigger context compaction' },
    { name: 'model', description: 'Switch the current session model' },
    { name: 'clear', description: 'Clear session messages' },
    { name: 'config', description: 'View or set configuration' },
  ]

  afterEach(() => {
    // 恢复默认空命令 mock，避免影响其他 describe
    vi.mocked(commandsAPI.list).mockResolvedValue({ commands: [] })
  })

  it('Enter 选择 popover 中高亮（过滤后）的命令，而非全列表同索引项', async () => {
    vi.mocked(commandsAPI.list).mockResolvedValue({ commands: TEST_COMMANDS })
    renderChat({ isStreaming: false })
    const editor = screen.getByTestId('composer-editor')

    editor.textContent = '/c'
    fireEvent.input(editor)

    const menu = await screen.findByTestId('slash-menu')
    const visibleNames = Array.from(menu.querySelectorAll('button strong')).map(
      (b) => b.textContent,
    )
    const activeName = menu.querySelector('.active strong')?.textContent ?? ''

    // 过滤后不含 help（全列表第一项）→ 证明过滤生效
    expect(visibleNames).not.toContain('/help')
    expect(activeName).not.toBe('/help')

    fireEvent.keyDown(editor, { key: 'Enter' })

    // 编辑器应包含高亮命令（而非全列表第一项 help）
    expect(editor.textContent).toContain(activeName.replace('/', ''))
    expect(editor.textContent).not.toMatch(/help/)
  })

  it('ArrowDown 导航后 Enter 选择导航到的项', async () => {
    vi.mocked(commandsAPI.list).mockResolvedValue({ commands: TEST_COMMANDS })
    renderChat({ isStreaming: false })
    const editor = screen.getByTestId('composer-editor')

    editor.textContent = '/c'
    fireEvent.input(editor)

    const menu = await screen.findByTestId('slash-menu')
    const visibleNames = Array.from(menu.querySelectorAll('button strong')).map(
      (b) => b.textContent,
    )
    expect(visibleNames.length).toBeGreaterThanOrEqual(2)

    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    const secondActive = menu.querySelector('.active strong')?.textContent ?? ''
    expect(secondActive).toBe(visibleNames[1])

    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(editor.textContent).toContain(secondActive.replace('/', ''))
  })
})

describe('slash 子命令补全 popover', () => {
  const TEST_COMMANDS_WITH_SUBS = [
    { name: 'help', description: 'List available slash commands' },
    { name: 'compact', description: 'Manually trigger context compaction' },
    {
      name: 'workflow',
      description: 'Manage and run workflows',
      argsHint: '[list|run|show|create|edit] [name] [args]',
      subcommands: [
        { name: 'list', description: 'List available workflows' },
        { name: 'run', description: 'Run a workflow', usage: '<name> [args]' },
        { name: 'show', description: 'Show workflow source', usage: '<name>' },
        {
          name: 'create',
          description: 'Create a workflow from file',
          usage: '<name> --file <path>',
        },
        { name: 'edit', description: 'Edit workflow source', usage: '<name>' },
      ],
    },
  ]

  afterEach(() => {
    vi.mocked(commandsAPI.list).mockResolvedValue({ commands: [] })
  })

  it('输入 /workflow 后显示子命令 popover', async () => {
    vi.mocked(commandsAPI.list).mockResolvedValue({ commands: TEST_COMMANDS_WITH_SUBS })
    renderChat({ isStreaming: false })
    const editor = screen.getByTestId('composer-editor')

    editor.textContent = '/workflow '
    fireEvent.input(editor)

    const menu = await screen.findByTestId('subcommand-menu')
    const items = Array.from(menu.querySelectorAll('button strong')).map((b) => b.textContent)
    expect(items).toContain('/workflow list')
    expect(items).toContain('/workflow run')
    expect(items).toContain('/workflow show')
  })

  it('输入 /workflow r 过滤出 run 子命令', async () => {
    vi.mocked(commandsAPI.list).mockResolvedValue({ commands: TEST_COMMANDS_WITH_SUBS })
    renderChat({ isStreaming: false })
    const editor = screen.getByTestId('composer-editor')

    editor.textContent = '/workflow r'
    fireEvent.input(editor)

    const menu = await screen.findByTestId('subcommand-menu')
    const items = Array.from(menu.querySelectorAll('button strong')).map((b) => b.textContent)
    expect(items).toEqual(['/workflow run'])
  })

  it('Enter 选中子命令后插入 /workflow run ', async () => {
    vi.mocked(commandsAPI.list).mockResolvedValue({ commands: TEST_COMMANDS_WITH_SUBS })
    renderChat({ isStreaming: false })
    const editor = screen.getByTestId('composer-editor')

    editor.textContent = '/workflow '
    fireEvent.input(editor)

    await screen.findByTestId('subcommand-menu')
    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    fireEvent.keyDown(editor, { key: 'Enter' })

    // ArrowDown 从 list（index 0）→ run（index 1），选中后插入 /workflow run
    expect(editor.textContent).toContain('workflow run')
  })

  it('无 subcommands 的命令不触发子命令 popover', async () => {
    vi.mocked(commandsAPI.list).mockResolvedValue({ commands: TEST_COMMANDS_WITH_SUBS })
    renderChat({ isStreaming: false })
    const editor = screen.getByTestId('composer-editor')

    editor.textContent = '/help '
    fireEvent.input(editor)

    // /help 没有 subcommands → 不应出现 subcommand-menu
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('subcommand-menu')).toBeNull()
  })
})

describe('workflow run 补全 popover', () => {
  const TEST_WORKFLOWS = [
    {
      name: 'security-audit',
      description: '安全审计',
      argsHint: '[扫描目标]',
      phases: ['scan', 'verify', 'report'],
      source: 'builtin' as const,
    },
    {
      name: 'code-review',
      description: '代码审查',
      argsHint: '[目标]',
      phases: ['review'],
      source: 'builtin' as const,
    },
    {
      name: 'migration-check',
      description: '迁移检查',
      source: 'builtin' as const,
    },
  ]

  afterEach(() => {
    vi.mocked(workflowsAPI.list).mockResolvedValue({ workflows: [] })
  })

  it('输入 /workflow run 后显示 workflow 补全 popover', async () => {
    vi.mocked(workflowsAPI.list).mockResolvedValue({ workflows: TEST_WORKFLOWS })
    renderChat({ isStreaming: false })
    const editor = screen.getByTestId('composer-editor')

    editor.textContent = '/workflow run '
    fireEvent.input(editor)

    const menu = await screen.findByTestId('workflow-menu')
    const names = Array.from(menu.querySelectorAll('button strong')).map((b) => b.textContent)
    expect(names).toContain('security-audit')
    expect(names).toContain('code-review')
    expect(names).toContain('migration-check')

    // argsHint 应作为参数提示展示
    const texts = Array.from(menu.querySelectorAll('button')).map((b) => b.textContent ?? '')
    expect(texts.some((t) => t.includes('扫描目标'))).toBe(true)
    expect(texts.some((t) => t.includes('[目标]'))).toBe(true)
  })

  it('输入查询后 Enter 选择高亮的工作流名称', async () => {
    vi.mocked(workflowsAPI.list).mockResolvedValue({ workflows: TEST_WORKFLOWS })
    renderChat({ isStreaming: false })
    const editor = screen.getByTestId('composer-editor')

    editor.textContent = '/workflow run sec'
    fireEvent.input(editor)

    const menu = await screen.findByTestId('workflow-menu')
    const activeName = menu.querySelector('.active strong')?.textContent ?? ''
    expect(activeName).toBe('security-audit')

    fireEvent.keyDown(editor, { key: 'Enter' })

    // 编辑器应补全为 /workflow run security-audit （保留子命令前缀）
    expect(editor.textContent).toMatch(/security-audit/)
    expect(editor.textContent).toMatch(/\/workflow\s+run/)
  })

  it('ArrowDown 导航后 Enter 选择导航到的工作流', async () => {
    vi.mocked(workflowsAPI.list).mockResolvedValue({ workflows: TEST_WORKFLOWS })
    renderChat({ isStreaming: false })
    const editor = screen.getByTestId('composer-editor')

    editor.textContent = '/workflow run '
    fireEvent.input(editor)

    const menu = await screen.findByTestId('workflow-menu')
    const names = Array.from(menu.querySelectorAll('button strong')).map((b) => b.textContent)
    expect(names.length).toBeGreaterThanOrEqual(2)

    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    const secondActive = menu.querySelector('.active strong')?.textContent ?? ''
    expect(secondActive).toBe(names[1])

    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(editor.textContent).toContain(secondActive ?? '')
  })

  it('/workflow show/edit 子命令也触发补全', async () => {
    vi.mocked(workflowsAPI.list).mockResolvedValue({ workflows: TEST_WORKFLOWS })
    renderChat({ isStreaming: false })
    const editor = screen.getByTestId('composer-editor')

    editor.textContent = '/workflow show '
    fireEvent.input(editor)
    expect(await screen.findByTestId('workflow-menu')).toBeTruthy()

    // 输入空格后关闭 popover
    editor.textContent = '/workflow show code-review '
    fireEvent.input(editor)
    expect(screen.queryByTestId('workflow-menu')).toBeNull()
  })
})

describe('Chat view modes', () => {
  it('默认聊天模式，可切换到表格', () => {
    renderChat()
    expect(screen.getByTestId('view-chat').getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByTestId('table-view')).toBeNull()
    fireEvent.click(screen.getByTestId('view-table'))
    expect(screen.getByTestId('view-table').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('table-view')).toBeTruthy()
  })

  it('聊天/表格/原始 JSON 三态互斥切换', () => {
    renderChat()
    // 默认聊天
    expect(screen.getByTestId('view-chat').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('view-table').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('view-json').getAttribute('aria-pressed')).toBe('false')

    // 切到原始 JSON
    fireEvent.click(screen.getByTestId('view-json'))
    expect(screen.getByTestId('view-json').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('view-chat').getAttribute('aria-pressed')).toBe('false')

    // 切到表格
    fireEvent.click(screen.getByTestId('view-table'))
    expect(screen.getByTestId('view-table').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('view-json').getAttribute('aria-pressed')).toBe('false')
  })

  it('原始 JSON 视图露出空壳消息的 JSON', () => {
    // 空壳消息（content 为空）在聊天模式下隐藏，原始 JSON 视图应露出其 JSON。
    const timeline: TimelineRow[] = [
      {
        kind: 'message',
        message: {
          id: 'empty',
          sessionId: 's',
          role: 'assistant',
          content: [],
          tokenCount: 0,
          createdAt: 1,
        },
        ts: 1,
      },
    ]
    renderChat({ timeline })
    // 聊天模式下空壳消息被隐藏
    expect(screen.getByTestId('stream').textContent).not.toContain('"role"')
    fireEvent.click(screen.getByTestId('view-json'))
    // 原始 JSON 视图露出空壳消息
    expect(screen.getByTestId('stream').textContent).toContain('"role"')
  })
})

describe('Chat 空状态欢迎区', () => {
  /** 空状态行为依赖 Composer 经 FileReferenceProvider 注册的填入 API，
   *  故用真实 Provider 渲染（renderChat 不带该 Provider）。 */
  function renderWelcomeChat(timeline: TimelineRow[] = []) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <FileReferenceProvider>
          <FileSelectionContext.Provider
            value={{ selectedFile: null, openFile: () => {}, closeFile: () => {} }}
          >
            <Chat
              timeline={timeline}
              isStreaming={false}
              usage={null}
              pendingPermission={null}
              onSend={vi.fn()}
              onAbort={vi.fn()}
              onConfirm={vi.fn()}
              emptyState={<ChatWelcome />}
            />
          </FileSelectionContext.Provider>
        </FileReferenceProvider>
      </QueryClientProvider>,
    )
  }

  it('空会话时渲染欢迎区与示例卡片、能力提示', () => {
    renderWelcomeChat()
    expect(screen.getByTestId('chat-welcome')).toBeTruthy()
    expect(screen.getAllByTestId('welcome-card').length).toBe(EXAMPLE_TASKS.length)
    expect(screen.getByText('输入 / 查看命令，@ 引用文件')).toBeTruthy()
  })

  it('时间线有消息时不渲染欢迎区', () => {
    const timeline: TimelineRow[] = [
      {
        kind: 'message',
        message: {
          id: 'm1',
          sessionId: 's',
          role: 'user',
          content: [{ _tag: 'text', text: 'hi' }],
          tokenCount: 0,
          createdAt: 1,
        },
        ts: 1,
      },
    ]
    renderWelcomeChat(timeline)
    expect(screen.queryByTestId('chat-welcome')).toBeNull()
    expect(screen.queryByTestId('welcome-card')).toBeNull()
  })

  it('点击示例卡片把示例文本填入 composer 并聚焦', () => {
    renderWelcomeChat()
    fireEvent.click(screen.getAllByTestId('welcome-card')[0] as HTMLElement)

    const editor = screen.getByTestId('composer-editor')
    expect(editor.textContent).toContain(EXAMPLE_TASKS[0]?.prompt ?? '')
    expect(document.activeElement).toBe(editor)
  })
})
