import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
      <Chat {...base} {...overrides} />
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

  it('steer toggle routes input send to onSteer instead of onSend', () => {
    const h = renderChat()
    // 切到 steer 后 composer 发送走 onSteer（steer 可在运行中注入）
    fireEvent.click(screen.getByTestId('steer-toggle'))
    const editor = screen.getByTestId('composer-editor')
    editor.textContent = 'be concise'
    fireEvent.input(editor)
    fireEvent.click(screen.getByTestId('send'))
    expect(h.onSteer).toHaveBeenCalledWith('be concise')
    expect(h.onSend).not.toHaveBeenCalled()
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

  it('聊天模式显示全局 JSON 开关', () => {
    renderChat()
    expect(screen.getByTestId('toggle-all-json')).toBeTruthy()
  })

  it('表格模式隐藏全局 JSON 开关', () => {
    renderChat()
    fireEvent.click(screen.getByTestId('view-table'))
    expect(screen.queryByTestId('toggle-all-json')).toBeNull()
  })
})
