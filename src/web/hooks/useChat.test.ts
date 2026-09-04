import type { AgentError } from '@shared/types/agent.js'
import type { Message, MessageContent } from '@shared/types/message.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
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
  permissionTimeout: null,
  subagents: [],
  pendingSegmentBreak: null,
  interrupted: false,
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

  it('subagent_start 记录运行中的子 agent', () => {
    const s = reduceChatEvent(base, {
      _tag: 'subagent_start',
      childId: 'c1',
      agentType: 'researcher',
      description: '探索',
      background: false,
    })
    expect(s.subagents).toHaveLength(1)
    expect(s.subagents[0]).toMatchObject({ childId: 'c1', status: 'running' })
  })

  it('subagent_end 更新状态为 completed', () => {
    let s = reduceChatEvent(base, {
      _tag: 'subagent_start',
      childId: 'c1',
      agentType: 'researcher',
      description: 'x',
      background: false,
    })
    s = reduceChatEvent(s, {
      _tag: 'subagent_end',
      childId: 'c1',
      agentType: 'researcher',
      success: true,
      output: 'done',
    })
    expect(s.subagents.find((x) => x.childId === 'c1')?.status).toBe('completed')
  })

  it('subagent_end 失败时状态为 failed', () => {
    let s = reduceChatEvent(base, {
      _tag: 'subagent_start',
      childId: 'c2',
      agentType: 'coder',
      description: 'x',
      background: false,
    })
    s = reduceChatEvent(s, {
      _tag: 'subagent_end',
      childId: 'c2',
      agentType: 'coder',
      success: false,
    })
    expect(s.subagents.find((x) => x.childId === 'c2')?.status).toBe('failed')
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

  // 回归：confirmTool 返回 404（超时或已被其他标签页处理）时给出明确提示，
  // 避免「以为已批准」。此前该分支零覆盖。
  it('confirmTool 404 → 提示权限请求已过期或已处理', async () => {
    const sse =
      'data: {"_tag":"permission_required","toolCallId":"tc404","tool":"bash","input":{}}\n\n'
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
      // 确认端点 404：pending 已被消费/过期
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ error: { code: 'NOT_FOUND', message: 'No pending permission' } }),
      }
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
    expect(result.current.pendingPermission?.toolCallId).toBe('tc404')

    await act(async () => {
      result.current.confirm('tc404', true)
      // 等待 confirmTool promise rejection 的 catch 回调 setState
      await new Promise((r) => setTimeout(r, 0))
    })
    // 乐观关闭仍生效
    expect(result.current.pendingPermission).toBeNull()
    // 明确提示文案
    expect(result.current.error).toBe('权限请求已过期（超过 5 分钟未确认）或已处理，工具未执行')
  })
})

describe('useChat segment break', () => {
  afterEach(() => vi.restoreAllMocks())

  function makeWrapper() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
  }

  it('409 SEGMENT_BREAK_REQUIRED → 设置 pendingSegmentBreak，不设 error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: 'SEGMENT_BREAK_REQUIRED',
            message: '切换',
            details: { activeSegment: { provider: 'p', model: 'm', tools: ['read'] } },
          },
        }),
      })),
    )
    const { result } = renderHook(() => useChat('s1'), { wrapper: makeWrapper() })
    await act(async () => {
      await result.current.sendMessage('hi', { model: 'other' })
    })
    expect(result.current.pendingSegmentBreak).not.toBeNull()
    expect(result.current.pendingSegmentBreak?.activeSegment.model).toBe('m')
    expect(result.current.pendingSegmentBreak?.text).toBe('hi')
    expect(result.current.error).toBeNull()
  })

  it('confirmBreak → 以 confirmSegmentBreak:true 重发', async () => {
    let chatCall = 0
    const fetchMock = vi.fn(async (url: string, _init?: { body?: string }) => {
      if (url === '/api/chat') {
        chatCall++
        if (chatCall === 1) {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: {
                code: 'SEGMENT_BREAK_REQUIRED',
                message: '切换',
                details: { activeSegment: { provider: 'p', model: 'm', tools: [] } },
              },
            }),
          }
        }
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () => ({ done: true, value: undefined }),
            }),
          },
        }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useChat('s1'), { wrapper: makeWrapper() })
    await act(async () => {
      await result.current.sendMessage('hi', { model: 'other' })
    })
    expect(result.current.pendingSegmentBreak).not.toBeNull()

    await act(async () => {
      await result.current.confirmBreak(false)
    })
    // 重发后清除待发
    expect(result.current.pendingSegmentBreak).toBeNull()
    // 第二次 /api/chat 调用携带 confirmSegmentBreak:true
    const second = fetchMock.mock.calls[1]
    expect(second?.[0]).toBe('/api/chat')
    expect(JSON.parse(String(second?.[1]?.body)).confirmSegmentBreak).toBe(true)
  })

  it('cancelBreak → 移除乐观 user 消息并清除待发', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: 'SEGMENT_BREAK_REQUIRED',
            message: '切换',
            details: { activeSegment: { provider: 'p', model: 'm', tools: [] } },
          },
        }),
      })),
    )
    const { result } = renderHook(() => useChat('s1'), { wrapper: makeWrapper() })
    await act(async () => {
      await result.current.sendMessage('hi')
    })
    expect(result.current.messages.some((m) => m.role === 'user')).toBe(true)
    expect(result.current.pendingSegmentBreak).not.toBeNull()

    act(() => {
      result.current.cancelBreak()
    })
    expect(result.current.pendingSegmentBreak).toBeNull()
    expect(result.current.messages.some((m) => m.role === 'user')).toBe(false)
  })
})

describe('useChat abort', () => {
  afterEach(() => vi.restoreAllMocks())

  // 回归：abort 必须同时通知后端终止 agent，而不只是中断前端 SSE 读取。
  // 此前 abort 仅调用 abortRef.current?.abort()，后端依赖 stream.onAbort 检测断开，
  // 可能有延迟或遗漏，导致 agent 在后台继续运行。
  it('abort 调用后端 /api/chat/abort 终止 agent', async () => {
    const sse = 'data: {"_tag":"text_delta","text":"hi"}\n\n'
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
                // 模拟流未结束（不返回 done 事件），等待 abort
                return new Promise<{ done: boolean; value: undefined }>(() => {})
              },
            }),
          },
        }
      }
      return { ok: true, status: 200, json: async () => ({ aborted: true }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)

    const { result } = renderHook(() => useChat('s1'), { wrapper })

    // 启动流（不 await：mock reader 会阻塞）
    await act(async () => {
      void result.current.sendMessage('hi')
      // 等待 React 刷新 setState（sendMessage 在 await 前同步调用了 isStreaming:true）
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(result.current.isStreaming).toBe(true)

    act(() => {
      result.current.abort()
    })

    // isStreaming 立即变 false
    expect(result.current.isStreaming).toBe(false)
    // 后端 abort 端点被调用
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/abort',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sessionId: 's1' }),
      }),
    )
  })
})

// 回归（P0-4）：RUN_ACTIVE 并发守卫——该错误若落入「网络错误视为中断」分支，
// 乐观追加的 user 消息不撤回、用户只见持续中断横幅。此前该分支零覆盖。
describe('useChat 并发守卫（RUN_ACTIVE）', () => {
  afterEach(() => vi.restoreAllMocks())

  it('RUN_ACTIVE → 撤回乐观 user 消息并提示，不标记中断', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'RUN_ACTIVE', message: '已有进行中的对话' } }),
      })),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)

    const { result } = renderHook(() => useChat('s1'), { wrapper })
    await act(async () => {
      await result.current.sendMessage('hi')
    })
    // 乐观追加的 user 消息被撤回
    expect(result.current.messages.some((m) => m.role === 'user')).toBe(false)
    // 明确提示
    expect(result.current.error).toBe('该会话已有进行中的对话')
    // 不落入「网络错误视为中断」分支
    expect(result.current.interrupted).toBe(false)
  })
})
