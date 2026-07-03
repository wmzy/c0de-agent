import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSelectionContext } from '../contexts/FileSelectionContext.js'
import type { TimelineRow } from '../components/session/utils/timeline.js'
import { permissionAPI } from '../services/permission.js'
import { Chat } from './Chat.js'

// Composer 内部 useCommands 会请求 /api/commands；mock 掉避免真实网络调用。
vi.mock('../services/commands.js', () => ({
  commandsAPI: { list: vi.fn().mockResolvedValue({ commands: [] }) },
}))

vi.mock('../services/permission.js', () => ({
  permissionAPI: {
    getMode: vi.fn().mockResolvedValue({ mode: 'default' }),
    setMode: vi.fn().mockResolvedValue({ mode: 'auto' }),
  },
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
  it('默认渲染未勾选的自动授权开关，无警告', () => {
    renderChat()
    const toggle = screen.getByTestId('permission-mode-toggle') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.queryByText(/自动执行所有工具/)).toBeNull()
  })

  it('点击开关切换到 auto：调用 setMode 并显示警告', () => {
    renderChat()
    fireEvent.click(screen.getByTestId('permission-mode-toggle'))
    expect(vi.mocked(permissionAPI.setMode)).toHaveBeenCalledWith('auto')
    expect(screen.getByText(/自动执行所有工具/)).toBeTruthy()
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
