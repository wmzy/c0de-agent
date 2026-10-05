// 重试 / 恢复对话都要先 await 两次网络往返（/messages、/sessions/:id）才调用
// chat.retry 置流式态。这段窗口里按钮仍可点——双提交会起第二条 SSE 流
// （服务端 409 或工具重复执行）。此文件锁住「同一时刻只有一次重发在途」。

import { QueryClient } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatActions, ChatState } from '@/hooks/chatState.js'
import { useRetryResume } from '@/hooks/useRetryResume.js'
import { sessionAPI } from '@/services/session.js'

vi.mock('@/services/session.js', () => ({
  sessionAPI: { messages: vi.fn(), get: vi.fn() },
}))

const userMessage = {
  id: 'm1',
  sessionId: 's1',
  role: 'user' as const,
  content: [{ _tag: 'text' as const, text: '跑一下测试' }],
  tokenCount: 1,
  createdAt: 1,
}

function fakeChat() {
  return {
    messages: [],
    isStreaming: false,
    usage: null,
    error: null,
    pendingPermission: null,
    permissionTimeout: null,
    subagents: [],
    pendingSegmentBreak: null,
    pendingTrust: null,
    interrupted: false,
    attachedRun: false,
    compactionNotice: null,
    runPaused: false,
    runPauseReason: null,
    workflowProgress: null,
    retry: vi.fn().mockResolvedValue(true),
    reset: vi.fn(),
    clearInterrupted: vi.fn(),
  } as unknown as ChatState & ChatActions
}

function setup() {
  const chat = fakeChat()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onResumeStart = vi.fn()
  const view = renderHook(() =>
    useRetryResume({
      sessionId: 's1',
      chat,
      qc,
      selection: { provider: 'openai', model: 'gpt-4o' },
      agentName: 'primary',
      onResumeStart,
    }),
  )
  return { chat, view, onResumeStart }
}

describe('useRetryResume 重发防重入', () => {
  it('重发在途时重复点击只发起一次重试', async () => {
    let release!: (msgs: unknown) => void
    vi.mocked(sessionAPI.messages).mockImplementation(
      () => new Promise((resolve) => (release = resolve)) as never,
    )
    vi.mocked(sessionAPI.get).mockResolvedValue({ metadata: {} } as never)

    const { chat, view } = setup()
    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = view.result.current.handleRetryLast()
      second = view.result.current.handleRetryLast()
    })
    expect(view.result.current.resendPending).toBe(true)
    await act(async () => {
      release([userMessage])
      await Promise.all([first, second])
    })

    expect(sessionAPI.messages).toHaveBeenCalledTimes(1)
    expect(chat.retry).toHaveBeenCalledTimes(1)
    expect(view.result.current.resendPending).toBe(false)
  })

  it('上一次重发结束后可以再次重试', async () => {
    vi.mocked(sessionAPI.messages).mockResolvedValue([userMessage] as never)
    vi.mocked(sessionAPI.get).mockResolvedValue({ metadata: {} } as never)

    const { chat, view } = setup()
    await act(async () => {
      await view.result.current.handleRetryLast()
    })
    await act(async () => {
      await view.result.current.handleRetryLast()
    })

    expect(chat.retry).toHaveBeenCalledTimes(2)
    expect(view.result.current.resendPending).toBe(false)
  })

  it('恢复对话同样受防重入保护，起点回调只执行一次', async () => {
    let release!: (msgs: unknown) => void
    vi.mocked(sessionAPI.messages).mockImplementation(
      () => new Promise((resolve) => (release = resolve)) as never,
    )
    vi.mocked(sessionAPI.get).mockResolvedValue({ metadata: {} } as never)

    const { chat, view, onResumeStart } = setup()
    await act(async () => {
      const first = view.result.current.handleResume()
      const second = view.result.current.handleResume()
      release([userMessage])
      await Promise.all([first, second])
    })

    expect(onResumeStart).toHaveBeenCalledTimes(1)
    expect(chat.reset).toHaveBeenCalledTimes(1)
    expect(chat.retry).toHaveBeenCalledTimes(1)
  })
})
