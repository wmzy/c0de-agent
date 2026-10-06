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
import { ConfigProvider } from '@/contexts/ConfigContext.js'
import { FileSelectionContext } from '@/contexts/FileSelectionContext.js'
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
  useAgent: () => ({ pause: vi.fn(), resume: vi.fn(), paused: false }),
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
