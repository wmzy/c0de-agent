/**
 * 草稿页首条消息发送的回归用例。
 *
 * 缺陷：DraftSession.handleSend 先建会话、把首条消息暂存进 pendingFirstMessage，
 * 再 fire-and-forget 地导航到会话页（由目标页的 ChatSession 发出）。而「草稿页 →
 * 会话页」在预览面板有未保存修改时**必被** FilePreview 的 useBlocker veto（两条
 * path 平级 → ChatPage 连同预览面板一起卸载，故刻意不豁免），navigateTo 又把导航
 * 结果整条吞掉：被 veto 后 handleSend 仍返回 true，于是输入框已被清空且不回填、
 * creating 永不复位（发送键常驻「创建中…」且 Enter 被 busy 挡），那条消息还挂在
 * 空会话上等着日后「凭空」发出。修法是动手前先问一次预览面板是否脏。
 */

import { createRoutes, MemoryRouter } from '@native-router/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigProvider } from '@/contexts/ConfigContext.js'
import { FileSelectionContext } from '@/contexts/FileSelectionContext.js'
import { pendingFirstMessage } from '@/hooks/pendingFirstMessage.js'
import { sessionAPI } from '@/services/session.js'
import { ChatView } from '@/views/ChatView.js'

// DraftSession 用了 useRouter（navigateTo 走 imperative 导航）。
function TestView() {
  return null
}
const draftRoutes = createRoutes({
  children: [
    { path: '/projects/:projectId', component: () => TestView },
    { path: '/projects/:projectId/sessions/:sessionId', component: () => TestView },
  ],
})

// Composer 内部 useCommands / useQuery 的数据源
vi.mock('@/services/commands.js', () => ({
  commandsAPI: { list: vi.fn().mockResolvedValue({ commands: [] }) },
}))
vi.mock('@/services/workflows.js', () => ({
  workflowsAPI: { list: vi.fn().mockResolvedValue({ workflows: [] }) },
}))
vi.mock('@/services/permission.js', () => ({
  permissionAPI: {
    getMode: vi.fn().mockResolvedValue({ mode: 'default' }),
    setMode: vi.fn().mockResolvedValue({ mode: 'auto' }),
    removeAlwaysAllow: vi.fn().mockResolvedValue({ alwaysAllow: [] }),
  },
  broadcastModeChange: vi.fn(),
  subscribeModeChange: vi.fn(() => () => {}),
}))
vi.mock('@/services/agent.js', () => ({
  agentAPI: { listAgents: vi.fn().mockResolvedValue({ agents: [] }) },
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
vi.mock('@/hooks/useSupportsVision.js', () => ({ useSupportsVision: () => true }))

afterEach(() => {
  cleanup()
  sessionStorage.clear()
})

function renderDraft(hasUnsavedEdits: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (): ReactNode => (
    <MemoryRouter routes={draftRoutes} initialEntries={['/projects/p1']}>
      <QueryClientProvider client={qc}>
        <ConfigProvider>
          <FileSelectionContext.Provider
            value={{
              selectedFile: 'src/app.ts',
              openFile: () => {},
              closeFile: () => {},
              hasUnsavedEdits: () => hasUnsavedEdits,
            }}
          >
            <ChatView projectId="p1" sessionId={null} />
          </FileSelectionContext.Provider>
        </ConfigProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
  const view = render(ui())
  // 路由视图在 effect 里才解析出来：先 flush 再断言
  return act(async () => {}).then(() => view)
}

async function typeAndSend(text: string) {
  const editor = screen.getByTestId('composer-editor')
  editor.textContent = text
  fireEvent.input(editor)
  fireEvent.click(screen.getByTestId('send'))
}

describe('草稿页首条消息 · 预览面板有未保存修改', () => {
  it('不建会话、不导航，说清原因并把输入还回输入框', async () => {
    const create = vi
      .spyOn(sessionAPI, 'create')
      .mockResolvedValue({ id: 's-new' } as unknown as Awaited<
        ReturnType<typeof sessionAPI.create>
      >)
    await renderDraft(true)
    await screen.findByTestId('composer-editor')
    await typeAndSend('帮我看下这个 bug')

    await waitFor(() => expect(screen.getByTestId('send-error')).toBeInTheDocument())
    expect(screen.getByTestId('send-error').textContent).toContain('未保存的文件修改')
    // 关键：不能留下半截状态——会话没建、消息没被暂存、发送键不卡在「创建中…」
    expect(create).not.toHaveBeenCalled()
    expect(screen.getByTestId('send').textContent).toBe('发送')
    expect((screen.getByTestId('send') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('composer-editor').textContent).toBe('帮我看下这个 bug')
    // 不得给空会话留下待发送的载荷（否则日后打开它会凭空发出一条消息）
    expect(pendingFirstMessage.get('s-new')).toBeUndefined()
  })

  it('没有未保存修改时照常建会话并进入发送流程', async () => {
    const create = vi
      .spyOn(sessionAPI, 'create')
      .mockResolvedValue({ id: 's-ok' } as unknown as Awaited<ReturnType<typeof sessionAPI.create>>)
    await renderDraft(false)
    await screen.findByTestId('composer-editor')
    await typeAndSend('没有未保存修改')

    await waitFor(() => expect(create).toHaveBeenCalled())
    await waitFor(() => expect(pendingFirstMessage.get('s-ok')?.text).toBe('没有未保存修改'))
    create.mockRestore()
  })
})
