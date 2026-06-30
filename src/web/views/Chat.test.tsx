import type { Message } from '@shared/types/message.js'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Chat } from './Chat.js'

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
  render(<Chat {...base} {...overrides} />)
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
    // streaming 时默认发送被禁用；切到 steer 后允许输入（steer 可在运行中注入）
    fireEvent.click(screen.getByTestId('steer-toggle'))
    fireEvent.change(screen.getByTestId('input'), { target: { value: 'be concise' } })
    fireEvent.click(screen.getByTestId('send'))
    expect(h.onSteer).toHaveBeenCalledWith('be concise')
    expect(h.onSend).not.toHaveBeenCalled()
  })
})
