import type { Message } from '@shared/types/message.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Chat } from './Chat.js'

// Composer 内部 useCommands 会请求 /api/commands；mock 掉避免真实网络调用。
vi.mock('../services/commands.js', () => ({
  commandsAPI: { list: vi.fn().mockResolvedValue({ commands: [] }) },
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
    messages: [] as Message[],
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
