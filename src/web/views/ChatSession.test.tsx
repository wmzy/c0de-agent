/**
 * ChatSession 会话页测试：历史消息加载失败的 UI 契约。
 * 失败必须显式报错 + 提供重试，绝不能退化成「全新空会话」欢迎页
 * （用户会以为上下文被清空，或对着不存在的上下文继续发消息）。
 */

import { createRoutes, MemoryRouter, View } from '@native-router/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { draftStorageKey } from '@/composer/draft.js'
import { ConfigProvider } from '@/contexts/ConfigContext.js'
import { FileSelectionContext } from '@/contexts/FileSelectionContext.js'
import { failedSendReason } from '@/hooks/failedSendReason.js'
import { sessionAPI } from '@/services/session.js'
import { storageGet, storageSet } from '@/utils/storage.js'
import { ChatSession } from '@/views/ChatSession.js'

// ChatSession 用了 useRouter（navigateTo 走 imperative 导航），测试需包 MemoryRouter。
let currentUi: ReactNode = null
function TestView() {
  return currentUi
}
const testRoutes = createRoutes({
  children: [
    { path: '/projects/:projectId', component: () => TestView },
    { path: '/projects/:projectId/sessions/:sessionId', component: () => TestView },
  ],
})

// ChatSession 内有多条 useQuery/挂载副作用，全部 mock 掉，只驱动 messages 一条。
const mockUseMessages = vi.fn()
vi.mock('@/hooks/useSession.js', () => ({ useMessages: () => mockUseMessages() }))

const mockUseChatState = {
  messages: [],
  isStreaming: false,
  error: null,
  usage: null,
  pendingPermission: null,
  permissionTimeout: null,
  workflowProgress: null,
  attachedRun: false,
  runPaused: false,
  interrupted: false,
  pendingTrust: null,
  // sendMessage 结果：由失败路径同步写入的 ref（值字段在 .then 里恒为旧值）。
  lastFailure: { current: { reason: null as string | null, gate: null as null | 'trust' } },
  sendMessage: vi.fn().mockResolvedValue(true),
  abort: vi.fn(),
  confirm: vi.fn(),
  steer: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  clearRunPaused: vi.fn(),
  reopenPermission: vi.fn(),
  denyTimedOutPermission: vi.fn(),
  attach: vi.fn().mockResolvedValue(undefined),
  resetPaused: vi.fn(),
  trustAndRetry: vi.fn(),
  clearError: vi.fn(),
  clearInterrupted: vi.fn(),
}
vi.mock('@/hooks/useChat.js', () => ({ useChat: () => mockUseChatState }))

vi.mock('@/hooks/useAgent.js', () => ({
  useAgent: () => ({
    pause: vi.fn(),
    resume: vi.fn(),
    resetPaused: vi.fn(),
    paused: false,
    busy: false,
    error: null,
  }),
}))

vi.mock('@/hooks/useShake.js', () => ({
  useShake: () => ({
    shakeContextValue: {},
    shakeMode: false,
    handleShakeOpen: vi.fn(),
    shakeToggle: vi.fn(),
    shakeRegions: [],
    shakeSelected: new Set<string>(),
    exitShakeMode: vi.fn(),
    shakePending: false,
    shakeMutation: { isPending: false, mutate: vi.fn() },
  }),
}))

vi.mock('@/hooks/useRetryResume.js', () => ({
  useRetryResume: () => ({ handleResume: vi.fn(), handleRetryLast: vi.fn(), resendPending: false }),
}))

vi.mock('@/hooks/useComposerDefaults.js', () => ({
  useComposerDefaults: () => ({
    selection: { provider: '', model: '' },
    setSelection: vi.fn(),
    enabledTools: null,
    setEnabledTools: vi.fn(),
    agentName: 'default',
    setAgentName: vi.fn(),
  }),
}))

vi.mock('@/services/session.js', () => ({
  sessionAPI: {
    get: vi.fn().mockResolvedValue({ id: 's1', projectId: 'p1', metadata: {} }),
    messages: vi.fn(),
    search: vi.fn(),
    llmDetails: vi.fn().mockResolvedValue([]),
    purgeEmpty: vi.fn(),
    exportSession: vi.fn(),
    branches: vi.fn().mockResolvedValue([]),
    rebind: vi.fn(),
    status: vi.fn().mockResolvedValue({ _tag: 'idle' }),
    pendingPermission: vi.fn().mockResolvedValue({ pending: null }),
    abort: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    steer: vi.fn(),
    open: vi.fn().mockResolvedValue(undefined),
    todo: vi.fn().mockResolvedValue([]),
    llmSummary: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('@/services/agent.js', () => ({
  agentAPI: { listAgents: vi.fn().mockResolvedValue({ agents: [] }) },
}))

vi.mock('@/services/provider.js', () => ({
  providerAPI: { capabilities: vi.fn().mockResolvedValue({ supportsVision: true }) },
}))

vi.mock('@/services/commands.js', () => ({
  commandsAPI: { list: vi.fn().mockResolvedValue({ commands: [] }) },
}))

vi.mock('@/services/config.js', () => ({
  configAPI: {
    get: vi
      .fn()
      .mockResolvedValue({ config: { providers: [{ name: 'mock' }] }, warnings: [], scopes: {} }),
  },
}))

vi.mock('@/services/workflows.js', () => ({
  workflowsAPI: { list: vi.fn().mockResolvedValue({ workflows: [] }) },
}))

vi.mock('@/services/permission.js', () => ({
  permissionAPI: {
    getMode: vi.fn().mockResolvedValue({ mode: 'default' }),
    setMode: vi.fn(),
    removeAlwaysAllow: vi.fn(),
  },
  broadcastModeChange: vi.fn(),
  subscribeModeChange: vi.fn(() => () => {}),
}))

const refetch = vi.fn().mockResolvedValue({ data: [] })

async function renderSession() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  currentUi = <ChatSession projectId="p1" sessionId="s1" />
  const view = render(
    <MemoryRouter routes={testRoutes} initialEntries={['/projects/p1/sessions/s1']}>
      <QueryClientProvider client={qc}>
        <ConfigProvider>
          <FileSelectionContext.Provider
            value={{ selectedFile: null, openFile: () => {}, closeFile: () => {} }}
          >
            <View />
          </FileSelectionContext.Provider>
        </ConfigProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
  // 路由 component 是懒加载：先 flush 一次 act 再断言
  await act(async () => {})
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ChatSession — 历史消息加载失败', () => {
  it('加载失败时显示错误与重试按钮，不退化成欢迎页', async () => {
    mockUseMessages.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { message: '数据库被占用，请稍后重试' },
      refetch,
    })
    await renderSession()

    await waitFor(() => {
      expect(screen.getByTestId('chat-history-error')).toBeInTheDocument()
    })
    // 关键：拉不到 ≠ 空的。欢迎页不能出现
    expect(screen.queryByTestId('chat-welcome')).toBeNull()
    expect(screen.getByTestId('chat-history-error').textContent).toContain('数据库被占用')
    expect(screen.getByTestId('chat-history-retry')).toBeInTheDocument()
  })

  it('点击重试触发 refetch', async () => {
    mockUseMessages.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { message: '加载失败' },
      refetch,
    })
    await renderSession()
    await waitFor(() => expect(screen.getByTestId('chat-history-retry')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('chat-history-retry'))
    expect(refetch).toHaveBeenCalled()
  })

  it('历史加载成功但为空时显示欢迎页（正常空会话）', async () => {
    mockUseMessages.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    })
    await renderSession()
    await waitFor(() => {
      expect(screen.getByTestId('chat-welcome')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('chat-history-error')).toBeNull()
  })
})

/**
 * LLM 调用明细读取失败必须显式报错 + 可重试。
 * 该 query 只取 data 时，buildTimeline 拿空段列表渲染出「只有消息、没有调用/段标记」
 * 的时间线——把「拉不到」说成「这次会话没有调用」，且消失的正是表格/原始 JSON 视图
 * 排障所依赖的调用与成本信息。
 */
describe('ChatSession — 调用明细（llm-details）读取失败', () => {
  beforeEach(() => {
    mockUseMessages.mockReturnValue({
      data: [{ id: 'm1', role: 'user', content: [], createdAt: 1 }],
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    })
  })

  it('失败时说明原因并给重试，不把「读不到」渲染成「没有调用」', async () => {
    vi.mocked(sessionAPI.llmDetails).mockRejectedValue({ message: '调用明细表暂不可用' })
    await renderSession()

    await waitFor(() => expect(screen.getByTestId('llm-details-error')).toBeInTheDocument())
    expect(screen.getByTestId('llm-details-error').textContent).toContain('调用明细表暂不可用')
    expect(screen.getByTestId('llm-details-error').textContent).toContain('不是本次会话没有调用')
    expect(screen.getByTestId('llm-details-retry')).toBeInTheDocument()
  })

  it('点击重试重新拉取调用明细', async () => {
    vi.mocked(sessionAPI.llmDetails).mockRejectedValue({ message: '调用明细表暂不可用' })
    await renderSession()
    await waitFor(() => expect(screen.getByTestId('llm-details-retry')).toBeInTheDocument())
    expect(sessionAPI.llmDetails).toHaveBeenCalledTimes(1)

    vi.mocked(sessionAPI.llmDetails).mockResolvedValue([])
    fireEvent.click(screen.getByTestId('llm-details-retry'))

    await waitFor(() => expect(sessionAPI.llmDetails).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId('llm-details-error')).toBeNull())
  })

  it('读取成功时不渲染该失败行', async () => {
    vi.mocked(sessionAPI.llmDetails).mockResolvedValue([])
    await renderSession()
    await waitFor(() => expect(screen.getByTestId('composer-editor')).toBeInTheDocument())
    expect(screen.queryByTestId('llm-details-error')).toBeNull()
  })
})

/**
 * 首条消息失败的「空会话治理」不能吞掉需要用户决策的失败。
 * 未信任项目的 409 TRUST_REQUIRED / 段边界确认的弹窗都渲染在 ChatSession 内，
 * 清空会话 + 导航回草稿页会把弹窗连同失败原因一起卸载：用户只看到一句没有任何
 * 信息量的「消息发送失败，请重试后再次发送」，且每次重试必然复现（无法开始对话）。
 */
describe('ChatSession — 首条消息失败的空会话治理', () => {
  async function sendFirstMessage() {
    const editor = screen.getByTestId('composer-editor')
    editor.textContent = '第一条消息'
    fireEvent.input(editor)
    fireEvent.keyDown(editor, { key: 'Enter' })
  }

  beforeEach(() => {
    mockUseMessages.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    })
    vi.mocked(sessionAPI.messages).mockResolvedValue([])
    mockUseChatState.sendMessage.mockResolvedValue(false)
    mockUseChatState.lastFailure.current = { reason: null, gate: null }
  })

  it('失败等待用户决策（未信任项目）时不清空会话——弹窗必须留在原地', async () => {
    mockUseChatState.lastFailure.current = {
      reason: '项目「p1」的项目配置（.c0de/config.json）包含需要你确认的风险项',
      gate: 'trust',
    }
    await renderSession()
    await waitFor(() => expect(screen.getByTestId('composer-editor')).toBeInTheDocument())

    await sendFirstMessage()

    await waitFor(() => expect(mockUseChatState.sendMessage).toHaveBeenCalled())
    expect(sessionAPI.purgeEmpty).not.toHaveBeenCalled()
  })

  it('普通首条失败仍清空会话，并把服务端原因（而非兜底文案）带回草稿页', async () => {
    mockUseChatState.lastFailure.current = {
      reason: '未找到名为「prov-x」的 AI 服务。已配置：mock。',
      gate: null,
    }
    await renderSession()
    await waitFor(() => expect(screen.getByTestId('composer-editor')).toBeInTheDocument())

    await sendFirstMessage()

    await waitFor(() => expect(sessionAPI.purgeEmpty).toHaveBeenCalled())
    expect(failedSendReason.take('p1')?.reason).toBe(
      '未找到名为「prov-x」的 AI 服务。已配置：mock。',
    )
  })

  // 回归（审查 #7）：发送失败的还原分支把失败快照落回 composer-draft.v1:s:<sessionId>，
  // 随后 purgeEmpty 物理删除会话——这份草稿再无人读取（文本无上限、图片最多
  // ~512KB），不清退就永久滞留 localStorage。
  it('首条失败清空会话后，会话草稿键随之清退（还原分支落回的快照不滞留）', async () => {
    mockUseChatState.lastFailure.current = { reason: '与服务的连接中断，消息未发出。', gate: null }
    await renderSession()
    await waitFor(() => expect(screen.getByTestId('composer-editor')).toBeInTheDocument())
    // 预置一份「失败快照」草稿（还原分支也会写入同样内容，这里显式钉住起点）
    storageSet(
      draftStorageKey('s:s1'),
      JSON.stringify({
        prompt: [{ type: 'text', start: 0, end: 5, content: '第一条消息' }],
        images: [],
      }),
    )

    await sendFirstMessage()

    await waitFor(() => expect(sessionAPI.purgeEmpty).toHaveBeenCalled())
    await waitFor(() => {
      expect(storageGet(draftStorageKey('s:s1'))).toBeNull()
    })
  })
})

describe('ChatSession — 孤儿会话归属', () => {
  it('归属失败时给出后端原因，按钮恢复可点', async () => {
    vi.mocked(sessionAPI.get).mockResolvedValue({
      id: 's1',
      projectId: null,
      metadata: {},
    } as unknown as Awaited<ReturnType<typeof sessionAPI.get>>)
    vi.mocked(sessionAPI.rebind).mockRejectedValue(new Error('项目已被删除'))
    mockUseMessages.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    })
    await renderSession()

    const btn = await screen.findByRole('button', { name: '归属到当前项目' })
    fireEvent.click(btn)

    const err = await screen.findByTestId('orphan-rebind-error')
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toContain('项目已被删除')
    // 失败不再把用户永久挡在按钮外：横幅留在原地，可以再试一次
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByTestId('orphan-session-banner')).toBeTruthy()
  })

  it('归属成功后退掉错误并收起横幅', async () => {
    vi.mocked(sessionAPI.get).mockResolvedValue({
      id: 's1',
      projectId: null,
      metadata: {},
    } as unknown as Awaited<ReturnType<typeof sessionAPI.get>>)
    vi.mocked(sessionAPI.rebind)
      .mockRejectedValueOnce(new Error('服务重启中'))
      .mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof sessionAPI.rebind>>)
    mockUseMessages.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    })
    await renderSession()

    const btn = await screen.findByRole('button', { name: '归属到当前项目' })
    fireEvent.click(btn)
    await screen.findByTestId('orphan-rebind-error')

    fireEvent.click(btn)
    await waitFor(() => expect(screen.queryByTestId('orphan-rebind-error')).toBeNull())
  })
})

describe('ChatSession — 导出反馈闭环', () => {
  it('导出失败时显示原因，按钮恢复可点', async () => {
    // 请求在飞期间按钮禁用：连点不再发出第二次导出请求
    let rejectExport: (err: Error) => void = () => {}
    vi.mocked(sessionAPI.exportSession).mockReturnValue(
      new Promise((_, reject) => {
        rejectExport = reject
      }),
    )
    mockUseMessages.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    })
    await renderSession()

    const btn = await screen.findByTestId('export-button')
    fireEvent.click(btn)
    const strip = await screen.findByTestId('export-strip-snapshots')
    fireEvent.click(strip)
    await waitFor(() => expect((strip as HTMLButtonElement).disabled).toBe(true))
    fireEvent.click(strip)
    expect(sessionAPI.exportSession).toHaveBeenCalledTimes(1)

    await act(async () => {
      rejectExport(new Error('数据库被占用'))
    })

    const err = await screen.findByTestId('export-dialog-error')
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toContain('数据库被占用')
    await waitFor(() => expect((strip as HTMLButtonElement).disabled).toBe(false))
  })

  it('导出失败后重试成功，错误条消失', async () => {
    vi.mocked(sessionAPI.exportSession)
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce({
        version: 1,
        session: { title: 's' },
        messages: [],
      } as unknown as Awaited<ReturnType<typeof sessionAPI.exportSession>>)
    mockUseMessages.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    })
    // happy-dom 没有下载实现：只关心失败条消失与第二次请求真的发出
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await renderSession()

    fireEvent.click(await screen.findByTestId('export-button'))
    fireEvent.click(await screen.findByTestId('export-strip-snapshots'))
    await screen.findByTestId('export-dialog-error')

    fireEvent.click(await screen.findByTestId('export-strip-snapshots'))
    await waitFor(() => expect(screen.queryByTestId('export-dialog')).toBeNull())
    expect(sessionAPI.exportSession).toHaveBeenCalledTimes(2)
  })

  // 快照策略是隐私选择：原生 confirm 只能给「确定/取消」，而「确定」（含快照、
  // 会泄露文件内容）正落在回车默认位——按回车就把文件正文打进了要分享的文件。
  it('导出弹窗把快照策略做成两个具名按钮，默认项不含快照', async () => {
    mockUseMessages.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.mocked(sessionAPI.exportSession).mockResolvedValue({
      version: 1,
      session: { title: 's' },
      messages: [],
    } as unknown as Awaited<ReturnType<typeof sessionAPI.exportSession>>)
    await renderSession()

    fireEvent.click(await screen.findByTestId('export-button'))
    // 分支数量查完前不允许盲选（避免决策完又弹第二个框）
    await waitFor(() =>
      expect((screen.getByTestId('export-strip-snapshots') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    fireEvent.click(screen.getByTestId('export-include-snapshots'))
    await waitFor(() =>
      expect(sessionAPI.exportSession).toHaveBeenCalledWith('s1', { includeSnapshots: true }),
    )
  })

  it('有派生分支时在同一个弹窗里说明，不再追弹第二个原生 confirm', async () => {
    vi.mocked(sessionAPI.branches).mockResolvedValue([
      { id: 'b1', projectId: 'p1', title: '子会话' },
    ] as unknown as Awaited<ReturnType<typeof sessionAPI.branches>>)
    mockUseMessages.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    })
    await renderSession()

    fireEvent.click(await screen.findByTestId('export-button'))
    await waitFor(() =>
      expect(screen.getByTestId('export-dialog').textContent).toContain('1 个派生分支'),
    )
    expect(sessionAPI.exportSession).not.toHaveBeenCalled()
  })

  // 读不到分支数 ≠ 没有分支：此前 catch(() => []) 把失败吞成 0，弹窗改口宣称
  // 「导出内容：本会话的全部消息与归档」，用户据此把导出件当成完整备份，
  // 而派生分支的内容并不在其中（迁移/分享后静默丢失）。
  it('派生分支数量读取失败：不谎报「内容完整」，给出原因与重试并放行导出', async () => {
    vi.mocked(sessionAPI.branches).mockRejectedValue(new Error('连接超时'))
    mockUseMessages.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.mocked(sessionAPI.exportSession).mockResolvedValue({
      version: 1,
      session: { title: 's' },
      messages: [],
    } as unknown as Awaited<ReturnType<typeof sessionAPI.exportSession>>)
    await renderSession()

    fireEvent.click(await screen.findByTestId('export-button'))
    const note = await screen.findByTestId('export-branch-note')
    await waitFor(() => expect(note.textContent).toContain('无法确认派生分支数量'))
    expect(note.textContent).toContain('连接超时')
    expect(note.textContent).not.toContain('导出内容：本会话的全部消息与归档')

    // 失败不再把用户永久挡在按钮外：能导出，只是不宣称完整
    const strip = screen.getByTestId('export-strip-snapshots') as HTMLButtonElement
    await waitFor(() => expect(strip.disabled).toBe(false))

    // 重试成功后恢复「确实没有分支」的说明
    vi.mocked(sessionAPI.branches).mockResolvedValue(
      [] as unknown as Awaited<ReturnType<typeof sessionAPI.branches>>,
    )
    fireEvent.click(screen.getByTestId('export-branch-retry'))
    await waitFor(() =>
      expect(screen.getByTestId('export-branch-note').textContent).toContain(
        '导出内容：本会话的全部消息与归档',
      ),
    )
  })
})

/**
 * 冷启动状态检查（sessionAPI.status）失败此前被 .catch(() => {}) 空吞：
 * 页面看起来完全正常，但「连接已中断 / 已暂停」的恢复横幅与入口都不会出现——
 * 用户面对一个上次被强杀打断的会话无从恢复，只能猜着重发，而重发会重复执行
 * 已跑过的工具（bash/git 等）。失败必须说出来并可重新检查。
 */
describe('ChatSession — 冷启动状态检查失败', () => {
  beforeEach(() => {
    mockUseMessages.mockReturnValue({
      data: [{ id: 'm1', role: 'user', content: [], createdAt: 1 }],
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    })
  })

  it('检查失败时说明原因，不静默当作正常结束', async () => {
    vi.mocked(sessionAPI.status).mockRejectedValueOnce({ message: '数据库被占用' })
    await renderSession()

    await waitFor(() => expect(screen.getByTestId('cold-start-error')).toBeInTheDocument())
    expect(screen.getByTestId('cold-start-error').textContent).toContain('数据库被占用')
    // 不把失败当 idle：中断恢复入口的缺失必须可见
    expect(screen.queryByTestId('interrupt-banner')).toBeNull()
  })

  it('点击「重新检查」后拿到 interrupted 并显示恢复入口，告警消失', async () => {
    vi.mocked(sessionAPI.status).mockRejectedValueOnce({ message: '数据库被占用' })
    await renderSession()
    await waitFor(() => expect(screen.getByTestId('cold-start-error')).toBeInTheDocument())

    vi.mocked(sessionAPI.status).mockResolvedValueOnce({ _tag: 'interrupted' })
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))

    await waitFor(() => expect(screen.getByTestId('interrupt-banner')).toBeInTheDocument())
    expect(screen.queryByTestId('cold-start-error')).toBeNull()
  })
})

/**
 * 会话信息（GET /api/sessions/:id）读取失败必须显式报错 + 可重试。
 * 这条 query 的 data 同时供三处消费：归属重定向（URL 项目与真实归属不一致时跳转）、
 * 孤儿会话横幅（孤儿会话唯一的自救入口）、unfinishedRange（中断前半截轮次置灰）。
 * 只取 data 时，retry 耗尽后三者一起静默失效：用户在错误项目的上下文里发消息、
 * 孤儿会话只留下一个能打字但工具全失败的页面且零解释、被中断的半截输出不再置灰，
 * 页面上没有任何一处 role="alert"。
 */
describe('ChatSession — 会话信息读取失败', () => {
  beforeEach(() => {
    mockUseMessages.mockReturnValue({
      data: [{ id: 'm1', role: 'user', content: [], createdAt: 1 }],
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    })
  })

  it('失败时说明原因并给重试，而不是静默失去归属校验与孤儿入口', async () => {
    vi.mocked(sessionAPI.get).mockRejectedValue({ message: '会话表不可用' })
    await renderSession()

    await waitFor(() => expect(screen.getByTestId('session-meta-error')).toBeInTheDocument())
    expect(screen.getByTestId('session-meta-error').textContent).toContain('会话表不可用')
    expect(screen.getByTestId('session-meta-retry')).toBeInTheDocument()
  })

  it('点击重试重新拉取会话信息', async () => {
    vi.mocked(sessionAPI.get).mockRejectedValue({ message: '会话表不可用' })
    await renderSession()
    await waitFor(() => expect(screen.getByTestId('session-meta-retry')).toBeInTheDocument())
    const callsBeforeRetry = vi.mocked(sessionAPI.get).mock.calls.length

    vi.mocked(sessionAPI.get).mockResolvedValue({
      id: 's1',
      projectId: 'p1',
      metadata: {},
    } as never)
    fireEvent.click(screen.getByTestId('session-meta-retry'))

    await waitFor(() =>
      expect(vi.mocked(sessionAPI.get).mock.calls.length).toBeGreaterThan(callsBeforeRetry),
    )
    await waitFor(() => expect(screen.queryByTestId('session-meta-error')).toBeNull())
  })

  it('读取成功时不渲染该失败行', async () => {
    vi.mocked(sessionAPI.get).mockResolvedValue({
      id: 's1',
      projectId: 'p1',
      metadata: {},
    } as never)
    await renderSession()
    await waitFor(() => expect(screen.getByTestId('composer-editor')).toBeInTheDocument())
    expect(screen.queryByTestId('session-meta-error')).toBeNull()
  })
})
