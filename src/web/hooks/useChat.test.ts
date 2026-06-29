import type { AgentError } from '@shared/types/agent.js'
import type { Message, MessageContent } from '@shared/types/message.js'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatState } from './useChat.js'
import { reduceChatEvent, useChat } from './useChat.js'

const base: ChatState = {
  messages: [],
  isStreaming: true,
  usage: null,
  error: null,
  pendingPermission: null,
}

function asst(parts: MessageContent[]): Message[] {
  return [
    {
      id: 'a1',
      sessionId: 's',
      role: 'assistant',
      content: parts,
      tokenCount: 0,
      createdAt: 1,
    },
  ]
}

describe('reduceChatEvent', () => {
  it('text_delta 追加到新 assistant 消息', () => {
    const s = reduceChatEvent(base, { _tag: 'text_delta', text: 'hi' })
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]?.content[0]).toEqual({ _tag: 'text', text: 'hi' })
  })

  it('连续 text_delta 累积到同一 text part', () => {
    let s = reduceChatEvent(base, { _tag: 'text_delta', text: 'a' })
    s = reduceChatEvent(s, { _tag: 'text_delta', text: 'b' })
    expect(s.messages[0]?.content[0]).toEqual({ _tag: 'text', text: 'ab' })
  })

  it('tool_call_start + tool_call_end 配对成结果', () => {
    let s = reduceChatEvent(base, { _tag: 'text_delta', text: 'x' })
    s = reduceChatEvent(s, { _tag: 'tool_call_start', id: 't1', tool: 'read', input: {} })
    expect(s.messages[0]?.content).toHaveLength(2)
    s = reduceChatEvent(s, {
      _tag: 'tool_call_end',
      id: 't1',
      result: { _tag: 'success', output: 'ok' },
    })
    const parts = s.messages[0]?.content
    const result = parts?.find((p) => p._tag === 'tool_result')
    expect(result && result._tag === 'tool_result' ? result.output._tag : null).toBe('success')
  })

  it('thinking 作为独立 part', () => {
    const s = reduceChatEvent(
      { ...base, messages: asst([{ _tag: 'text', text: 'hi' }]) },
      { _tag: 'thinking', text: 'hmm' },
    )
    expect(s.messages[0]?.content[1]).toEqual({ _tag: 'thinking', text: 'hmm' })
  })

  it('连续 thinking chunk 累积到同一 part', () => {
    let s = reduceChatEvent(base, { _tag: 'thinking', text: 'a' })
    s = reduceChatEvent(s, { _tag: 'thinking', text: 'b' })
    s = reduceChatEvent(s, { _tag: 'thinking', text: 'c' })
    const parts = s.messages[0]?.content
    expect(parts).toHaveLength(1)
    expect(parts?.[0]).toEqual({ _tag: 'thinking', text: 'abc' })
  })

  it('usage 更新', () => {
    const s = reduceChatEvent(base, { _tag: 'usage', input: 10, output: 5 })
    expect(s.usage).toEqual({ input: 10, output: 5 })
  })

  it('done 结束流式', () => {
    const s = reduceChatEvent(base, { _tag: 'done' })
    expect(s.isStreaming).toBe(false)
  })

  it('llm_detail 是纯通知，状态不变（调用详情由 query 刷新）', () => {
    const s = reduceChatEvent(base, { _tag: 'llm_detail' })
    expect(s).toBe(base)
  })

  it('error 转消息', () => {
    const err: AgentError = { _tag: 'provider', message: 'boom', retryable: false }
    const s = reduceChatEvent(base, { _tag: 'error', error: err })
    expect(s.error).toBe('boom')
  })

  it('permission_required 设置 pending', () => {
    const s = reduceChatEvent(base, {
      _tag: 'permission_required',
      toolCallId: 'p1',
      tool: 'bash',
      input: {},
    })
    expect(s.pendingPermission).toEqual({ toolCallId: 'p1', tool: 'bash', input: {} })
  })
})

describe('useChat confirm', () => {
  afterEach(() => vi.restoreAllMocks())

  // 回归：点击「允许」后必须立即关闭弹窗。此前 handleConfirm 不清 pendingPermission，
  // 弹窗要等到 done 事件才关；期间重复点击会对后端已消费的 pending 触发 404。
  it('confirm 后立即乐观清空 pendingPermission 并通知后端', async () => {
    const sse =
      'data: {"_tag":"permission_required","toolCallId":"tc1","tool":"bash","input":{"command":"ls"}}\n\n'
    const chunk = new TextEncoder().encode(sse)
    let readIdx = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/chat') {
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () => {
                if (readIdx === 0) {
                  readIdx++
                  return { done: false, value: chunk }
                }
                return { done: true, value: undefined }
              },
            }),
          },
        }
      }
      return { ok: true, status: 200, json: async () => ({ confirmed: true }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)

    const { result } = renderHook(() => useChat('s1'), { wrapper })

    await act(async () => {
      await result.current.sendMessage('hi')
    })
    // permission_required 事件已设置 pending
    expect(result.current.pendingPermission?.toolCallId).toBe('tc1')

    act(() => {
      result.current.confirm('tc1', true)
    })

    // 乐观关闭：弹窗立即消失
    expect(result.current.pendingPermission).toBeNull()
    // 后端确认端点被调用（method POST + toolCallId）
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tools/confirm',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ toolCallId: 'tc1', approved: true }),
      }),
    )
  })
})
