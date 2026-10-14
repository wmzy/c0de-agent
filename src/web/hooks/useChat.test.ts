import type { AgentError } from '@shared/types/agent.js'
import type { Message, MessageContent } from '@shared/types/message.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createElement, StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatState } from '@/hooks/chatState.js'
import { reduceChatEvent } from '@/hooks/chatState.js'
import { useChat } from '@/hooks/useChat.js'
import { agentAPI } from '@/services/agent.js'

const base: ChatState = {
  messages: [],
  isStreaming: true,
  usage: null,
  error: null,
  pendingPermission: null,
  permissionTimeout: null,
  subagents: [],
  pendingSegmentBreak: null,
  pendingTrust: null,
  trustPending: false,
  trustError: null,
  interrupted: false,
  abortError: null,
  attachedRun: false,
  compactionNotice: null,
  runPaused: false,
  runPauseReason: null,
  workflowProgress: null,
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

  it('progress 设置工作流进度横幅，done 清除', () => {
    let s = reduceChatEvent(base, { _tag: 'progress', message: '并行扫描 12 个模块...' })
    expect(s.workflowProgress).toEqual({
      message: '并行扫描 12 个模块...',
      detail: undefined,
    })
    s = reduceChatEvent(s, { _tag: 'done' })
    expect(s.workflowProgress).toBeNull()
  })

  it('error 清除工作流进度横幅', () => {
    let s = reduceChatEvent(base, { _tag: 'progress', message: '生成报告...' })
    const err: AgentError = { _tag: 'provider', message: 'boom', retryable: false }
    s = reduceChatEvent(s, { _tag: 'error', error: err })
    expect(s.workflowProgress).toBeNull()
    expect(s.error).toBe('boom')
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

  it('permission_timeout 记录工具与超时动作（横幅文案由动作决定）', () => {
    const s = reduceChatEvent(base, {
      _tag: 'permission_timeout',
      toolCallId: 'p2',
      tool: 'write',
      input: { path: 'a.ts' },
      timeoutAction: 'pause',
    })
    expect(s.permissionTimeout).toMatchObject({ tool: 'write', timeoutAction: 'pause' })
    expect(s.pendingPermission).toBeNull()
  })

  it('permission_expired pause → runPaused=true（显示恢复入口）', () => {
    const s = reduceChatEvent(base, {
      _tag: 'permission_expired',
      toolCallId: 'p3',
      tool: 'bash',
      input: {},
      timeoutAction: 'pause',
    })
    expect(s.runPaused).toBe(true)
    expect(s.permissionTimeout).toBeNull()
    expect(s.pendingPermission).toBeNull()
  })

  it('permission_expired deny → run 继续，runPaused 保持 false（旧行为）', () => {
    const s = reduceChatEvent(base, {
      _tag: 'permission_expired',
      toolCallId: 'p4',
      tool: 'bash',
      input: {},
      timeoutAction: 'deny',
    })
    expect(s.runPaused).toBe(false)
  })

  it('status_change 同步服务端暂停态：paused→true，running→false', () => {
    let s = reduceChatEvent(base, {
      _tag: 'status_change',
      status: { _tag: 'paused', pauseReason: 'Permission request expired' },
    })
    expect(s.runPaused).toBe(true)
    s = reduceChatEvent(s, { _tag: 'status_change', status: { _tag: 'running', turnCount: 1 } })
    expect(s.runPaused).toBe(false)
  })

  it('done 清除 runPaused（暂停后恢复至完成）', () => {
    let s = reduceChatEvent(base, {
      _tag: 'status_change',
      status: { _tag: 'paused', pauseReason: 'x' },
    })
    s = reduceChatEvent(s, { _tag: 'done' })
    expect(s.runPaused).toBe(false)
    expect(s.isStreaming).toBe(false)
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

  it('compaction_done 设置压缩提示（自动压缩不再静默）', () => {
    const s = reduceChatEvent(base, {
      _tag: 'compaction_done',
      summary: 'sum',
      compactedCount: 12,
      keptCount: 5,
    })
    expect(s.compactionNotice).toContain('12')
    expect(s.compactionNotice).toContain('5')
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
      return {
        ok: true,
        status: 200,
        json: async () => ({ confirmed: true }),
        text: async () => JSON.stringify({ confirmed: true }),
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
    // permission_required 事件已设置 pending
    expect(result.current.pendingPermission?.toolCallId).toBe('tc1')

    // fetch-fun 请求在微任务内派发，async act 排空后断言后端调用
    await act(async () => {
      result.current.confirm('tc1', true)
    })

    // 乐观关闭：弹窗立即消失
    expect(result.current.pendingPermission).toBeNull()
    // 后端确认端点被调用（method POST + toolCallId）；fetch-fun 派发异步，waitFor 轮询
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/tools/confirm',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ toolCallId: 'tc1', approved: true }),
        }),
      ),
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
        text: async () =>
          JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No pending permission' } }),
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
    // 明确提示文案（P3 修正：不再宣称「超过 5 分钟未确认」过期）
    expect(result.current.error).toBe(
      '权限请求已被处理（可能在其他标签页确认/拒绝）或已中止，工具未执行',
    )
  })

  // 回归：confirmTool 500/网络失败（请求没送达）此前只 console.error——dock 已
  // 乐观关闭、用户以为「已批准/已拒绝」，服务端却仍持有 pending 等这个决定，
  // 页面上既没有原因也没有重新确认的入口。
  it('confirmTool 500 → 说明未送达，并把权限弹窗还回去', async () => {
    const sse =
      'data: {"_tag":"permission_required","toolCallId":"tc500","tool":"bash","input":{}}\n\n'
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
      // 确认端点 500：请求没送达，服务端 pending 仍在
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ error: { code: 'INTERNAL', message: 'boom' } }),
        text: async () => JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }),
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
    const pending = result.current.pendingPermission
    expect(pending?.toolCallId).toBe('tc500')

    await act(async () => {
      result.current.confirm('tc500', true, undefined, pending ?? undefined)
      await new Promise((r) => setTimeout(r, 0))
    })

    // 原因可见（此前整条失败路径零反馈）
    expect(result.current.error).toContain('权限确认没有送达')
    // 弹窗回来：用户可以再决定一次，服务端 pending 本来就没被消费
    expect(result.current.pendingPermission?.toolCallId).toBe('tc500')
  })

  // 回归：勾选「本会话始终允许」时白名单写入失败此前只 console.error，随后仍
  // 批准工具——用户看到的是一次完全成功的授权，但白名单没写进去，同一工具下次
  // 还会弹确认。工具照旧执行，但失败原因必须说出来。
  it('白名单写入失败时透出原因，工具仍按选择执行', async () => {
    const sse =
      'data: {"_tag":"permission_required","toolCallId":"tcAL","tool":"bash","input":{}}\n\n'
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
      if (url === '/api/permissions/s1/always-allow') {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({ error: { code: 'INTERNAL', message: '白名单存储不可用' } }),
          text: async () =>
            JSON.stringify({ error: { code: 'INTERNAL', message: '白名单存储不可用' } }),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ confirmed: true }),
        text: async () => JSON.stringify({ confirmed: true }),
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
    const pending = result.current.pendingPermission
    expect(pending?.toolCallId).toBe('tcAL')

    await act(async () => {
      result.current.confirm('tcAL', true, 'bash', pending ?? undefined)
      await new Promise((r) => setTimeout(r, 0))
    })

    // 原因可见（此前整条失败路径零反馈）
    expect(result.current.error).toContain('未保存')
    expect(result.current.error).toContain('白名单存储不可用')
    // 白名单失败不影响本次批准：工具确认请求照常发出
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/tools/confirm',
        expect.objectContaining({ body: JSON.stringify({ toolCallId: 'tcAL', approved: true }) }),
      ),
    )
  })

  it('白名单写入成功时不写 error', async () => {
    const sse =
      'data: {"_tag":"permission_required","toolCallId":"tcOK","tool":"bash","input":{}}\n\n'
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
      return {
        ok: true,
        status: 200,
        json: async () => ({ alwaysAllow: ['bash'], confirmed: true }),
        text: async () => JSON.stringify({ alwaysAllow: ['bash'], confirmed: true }),
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
    const pending = result.current.pendingPermission

    await act(async () => {
      result.current.confirm('tcOK', true, 'bash', pending ?? undefined)
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(result.current.error).toBeNull()
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/tools/confirm',
        expect.objectContaining({ body: JSON.stringify({ toolCallId: 'tcOK', approved: true }) }),
      ),
    )
  })

  // 回归：denyTimedOutPermission 把 confirmTool POST 写进 setState 更新器——
  // 更新器必须是纯函数，StrictMode（main.tsx 已开启）会重复调用它，同一
  // 拒绝请求被发出两次（服务端第二次必然 404，用户网络层收到多余请求）。
  it('denyTimedOutPermission fires exactly one confirmTool request under StrictMode', async () => {
    const sse =
      'data: {"_tag":"permission_timeout","toolCallId":"tcTO","tool":"bash","input":{},"timeoutAction":"pause"}\n\n'
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
      return {
        ok: true,
        status: 200,
        json: async () => ({ confirmed: true }),
        text: async () => JSON.stringify({ confirmed: true }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        StrictMode,
        null,
        createElement(QueryClientProvider, { client: queryClient }, children),
      )

    const { result } = renderHook(() => useChat('s1'), { wrapper })

    await act(async () => {
      await result.current.sendMessage('hi')
    })
    expect(result.current.permissionTimeout?.toolCallId).toBe('tcTO')

    await act(async () => {
      result.current.denyTimedOutPermission()
      // 拒绝请求现在是异步读结果的，等 promise 链的 setState 落地
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current.permissionTimeout).toBeNull()

    const confirmCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/tools/confirm')
    expect(confirmCalls).toHaveLength(1)
  })

  /** 渲染一个已进入「权限确认超时」态的会话（SSE 只发一条 permission_timeout）。 */
  async function renderTimedOut(toolCallId: string) {
    const sse = `data: {"_tag":"permission_timeout","toolCallId":"${toolCallId}","tool":"bash","input":{},"timeoutAction":"pause"}\n\n`
    const chunk = new TextEncoder().encode(sse)
    let readIdx = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
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
        return {
          ok: true,
          status: 200,
          json: async () => ({ confirmed: true }),
          text: async () => JSON.stringify({ confirmed: true }),
        }
      }),
    )

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    const { result } = renderHook(() => useChat('s1'), { wrapper })

    await act(async () => {
      await result.current.sendMessage('hi')
    })
    expect(result.current.permissionTimeout?.toolCallId).toBe(toolCallId)
    return result
  }

  // 回归：拒绝请求失败此前被 .catch(() => {}) 空吞、随后无条件清空 permissionTimeout——
  // 500 / 网络中断时拒绝根本没送达（服务端 pending 仍在，25 分钟宽限期内 run 继续等），
  // 而页面上唯一能再次进入该决策的超时横幅（「重新询问 / 拒绝并继续」）已经消失，
  // 用户零反馈、以为工具已被拒绝。
  it('denyTimedOutPermission 拒绝未送达（500）→ 保留超时横幅并说明原因', async () => {
    const result = await renderTimedOut('tcD500')
    vi.spyOn(agentAPI, 'confirmTool').mockRejectedValue(
      Object.assign(new Error('Internal Server Error'), { status: 500 }),
    )

    await act(async () => {
      result.current.denyTimedOutPermission()
      await new Promise((r) => setTimeout(r, 0))
    })

    // 横幅保留：两个入口（重新询问 / 拒绝并继续）仍在
    expect(result.current.permissionTimeout).not.toBeNull()
    expect(result.current.permissionTimeout?.toolCallId).toBe('tcD500')
    // 说清「拒绝没生效 / 工具还在等」而不是谎报成功
    expect(result.current.error).toContain('没有送达')
    expect(result.current.error).toContain('仍在等待')
  })

  it('denyTimedOutPermission 拒绝送达 → 清空超时态且无错误提示', async () => {
    const result = await renderTimedOut('tcDOK')
    vi.spyOn(agentAPI, 'confirmTool').mockResolvedValue({ confirmed: true })

    await act(async () => {
      result.current.denyTimedOutPermission()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(result.current.permissionTimeout).toBeNull()
    expect(result.current.error).toBeNull()
  })

  // 404：pending 已被其他标签页消费 / run 已中止——工具不会执行，超时态该收起，
  // 文案与 confirm() 同一口径。
  it('denyTimedOutPermission 404（已被处理）→ 清空超时态并给出同一口径文案', async () => {
    const result = await renderTimedOut('tcD404')
    vi.spyOn(agentAPI, 'confirmTool').mockRejectedValue(
      Object.assign(new Error('No pending permission'), { status: 404 }),
    )

    await act(async () => {
      result.current.denyTimedOutPermission()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(result.current.permissionTimeout).toBeNull()
    expect(result.current.error).toBe(
      '权限请求已被处理（可能在其他标签页确认/拒绝）或已中止，工具未执行',
    )
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
        text: async () =>
          JSON.stringify({
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
            text: async () =>
              JSON.stringify({
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
      return { ok: true, status: 200, json: async () => ({}), text: async () => JSON.stringify({}) }
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

  /** 先触发段边界（第一次 /api/chat 回 409），供 confirmBreak(true) 的用例复用。 */
  function segmentBreakThenStreamFetch(compactResponse: () => unknown) {
    let chatCall = 0
    return vi.fn(async (url: string) => {
      if (url === '/api/sessions/s1/compact') return compactResponse()
      if (url === '/api/chat') {
        chatCall++
        if (chatCall === 1) {
          const body = {
            error: {
              code: 'SEGMENT_BREAK_REQUIRED',
              message: '切换',
              details: { activeSegment: { provider: 'p', model: 'm', tools: [] } },
            },
          }
          return {
            ok: false,
            status: 409,
            json: async () => body,
            text: async () => JSON.stringify(body),
          }
        }
        return {
          ok: true,
          status: 200,
          body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
        }
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
    })
  }

  /**
   * 回归：HTTP 200 不代表压缩受理。
   * 服务端在「消息过少 / 无内容可压缩」时回 {compacted:false, reason}（消息过少
   * 的用例被 session.test.ts 钉死）。此前 compact 的返回值被整段丢弃，用户明确
   * 点了「顺便压缩会话」却什么都没发生，且重发后同一段边界会再次弹层。
   */
  it('confirmBreak(true) 回 {compacted:false} → 透出「未压缩」而不是静默放行', async () => {
    const fetchMock = segmentBreakThenStreamFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ compacted: false, reason: 'too_few_messages' }),
      text: async () => JSON.stringify({ compacted: false, reason: 'too_few_messages' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useChat('s1'), { wrapper: makeWrapper() })
    await act(async () => {
      await result.current.sendMessage('hi', { model: 'other' })
    })
    expect(result.current.pendingSegmentBreak).not.toBeNull()

    await act(async () => {
      await result.current.confirmBreak(true)
    })
    // 确实调用了压缩端点（不是直接开新段）
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/sessions/s1/compact')).toBe(true)
    // 未受理必须可见：文案点明「没压缩」与原因，不能静默当作成功
    expect(result.current.error).toContain('未压缩')
    expect(result.current.error).toContain('消息太少')
  })

  /**
   * 回归：压缩请求本身失败此前只 console.error（Electron/浏览器控制台之外不可见）。
   * 用户以为上下文已摘要，实际按未压缩内容继续开新段。
   */
  it('confirmBreak(true) 压缩请求失败 → 透出原因，而不只是 console', async () => {
    const fetchMock = segmentBreakThenStreamFetch(() => ({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: 'COMPACTION_FAILED', message: '压缩服务不可用' } }),
      text: async () =>
        JSON.stringify({ error: { code: 'COMPACTION_FAILED', message: '压缩服务不可用' } }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useChat('s1'), { wrapper: makeWrapper() })
    await act(async () => {
      await result.current.sendMessage('hi', { model: 'other' })
    })
    await act(async () => {
      await result.current.confirmBreak(true)
    })
    expect(result.current.error).toContain('会话压缩失败')
    expect(result.current.error).toContain('压缩服务不可用')
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
        text: async () =>
          JSON.stringify({
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

  it('409 TRUST_REQUIRED → 设置 pendingTrust（含风险项 details）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: 'TRUST_REQUIRED',
            message: '需要信任',
            details: {
              projectId: 'proj-1',
              projectName: 'Sneaky Repo',
              items: [
                { kind: 'permission-auto', detail: '权限模式 auto' },
                { kind: 'plugins-enabled', detail: '启用插件 evil' },
              ],
            },
          },
        }),
        text: async () =>
          JSON.stringify({
            error: {
              code: 'TRUST_REQUIRED',
              message: '需要信任',
              details: {
                projectId: 'proj-1',
                projectName: 'Sneaky Repo',
                items: [
                  { kind: 'permission-auto', detail: '权限模式 auto' },
                  { kind: 'plugins-enabled', detail: '启用插件 evil' },
                ],
              },
            },
          }),
      })),
    )
    const { result } = renderHook(() => useChat('s1'), { wrapper: makeWrapper() })
    await act(async () => {
      await result.current.sendMessage('hi')
    })
    expect(result.current.pendingTrust).not.toBeNull()
    expect(result.current.pendingTrust?.projectName).toBe('Sneaky Repo')
    expect(result.current.pendingTrust?.items).toHaveLength(2)
    expect(result.current.pendingTrust?.text).toBe('hi')
    expect(result.current.error).toBeNull()
  })

  it('confirmTrust → 信任项目后按原内容重发并清除待办', async () => {
    let chatCall = 0
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (url === '/api/chat') {
        chatCall++
        if (chatCall === 1) {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: {
                code: 'TRUST_REQUIRED',
                message: '需要信任',
                details: {
                  projectId: 'proj-1',
                  projectName: 'Repo',
                  items: [{ kind: 'permission-auto', detail: 'auto' }],
                },
              },
            }),
            text: async () =>
              JSON.stringify({
                error: {
                  code: 'TRUST_REQUIRED',
                  message: '需要信任',
                  details: {
                    projectId: 'proj-1',
                    projectName: 'Repo',
                    items: [{ kind: 'permission-auto', detail: 'auto' }],
                  },
                },
              }),
          }
        }
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({ read: async () => ({ done: true, value: undefined }) }),
          },
        }
      }
      if (url === '/api/projects/proj-1/trust' && init?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
          text: async () => JSON.stringify({ ok: true }),
        }
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => JSON.stringify({}) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useChat('s1'), { wrapper: makeWrapper() })
    await act(async () => {
      await result.current.sendMessage('hi')
    })
    expect(result.current.pendingTrust).not.toBeNull()

    await act(async () => {
      await result.current.confirmTrust()
    })
    expect(result.current.pendingTrust).toBeNull()
    // 调用序列：首次 /api/chat → 信任端点 → 按原内容重发 /api/chat
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/projects/proj-1/trust')
    const resend = fetchMock.mock.calls[2]
    expect(resend?.[0]).toBe('/api/chat')
    expect(JSON.parse(String(resend?.[1]?.body)).message).toBe('hi')
  })

  // 回归：信任请求失败此前只把原因写进 state.error——它是记录在会话区的横幅，
  // 而信任弹窗是 <dialog> 模态（::backdrop 遮住页面其余内容），用户看到的是
  // 「点了信任并继续，弹窗纹丝不动」，既没有原因也无从判断按钮是否工作过。
  // 现在原因必须落到 trustError（渲染在弹窗内部），并在在飞期间置 trustPending。
  it('confirmTrust 失败 → 还原待办、原因进 trustError、busy 复位', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (url === '/api/chat') {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: {
                code: 'TRUST_REQUIRED',
                message: '需要信任',
                details: {
                  projectId: 'proj-1',
                  projectName: 'Repo',
                  items: [{ kind: 'permission-auto', detail: 'auto' }],
                },
              },
            }),
            text: async () =>
              JSON.stringify({
                error: {
                  code: 'TRUST_REQUIRED',
                  message: '需要信任',
                  details: {
                    projectId: 'proj-1',
                    projectName: 'Repo',
                    items: [{ kind: 'permission-auto', detail: 'auto' }],
                  },
                },
              }),
          }
        }
        if (url === '/api/projects/proj-1/trust' && init?.method === 'POST') {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: { message: '信任写入失败' } }),
            text: async () => JSON.stringify({ error: { message: '信任写入失败' } }),
          }
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
      }),
    )

    const { result } = renderHook(() => useChat('s1'), { wrapper: makeWrapper() })
    await act(async () => {
      await result.current.sendMessage('hi')
    })
    expect(result.current.pendingTrust).not.toBeNull()

    await act(async () => {
      await result.current.confirmTrust()
    })
    // 待办还原（弹窗仍开着），失败原因在弹窗内部可见，busy 归位可重试
    expect(result.current.pendingTrust).not.toBeNull()
    expect(result.current.trustPending).toBe(false)
    expect(result.current.trustError).toContain('信任项目失败')
    expect(result.current.trustError).toContain('信任写入失败')

    // 取消：清掉失败原因与待办（不残留旧原因到下一次信任）
    act(() => {
      result.current.cancelTrust()
    })
    expect(result.current.pendingTrust).toBeNull()
    expect(result.current.trustError).toBeNull()
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
      return {
        ok: true,
        status: 200,
        json: async () => ({ aborted: true }),
        text: async () => JSON.stringify({ aborted: true }),
      }
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

    // fetch-fun 请求在微任务内派发，async act 排空后断言后端调用
    await act(async () => {
      result.current.abort()
    })

    // isStreaming 立即变 false
    expect(result.current.isStreaming).toBe(false)
    // 后端 abort 端点被调用；fetch-fun 派发异步，waitFor 轮询
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat/abort',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ sessionId: 's1' }),
        }),
      ),
    )
    // 停下来了：没有待处理的失败原因
    await waitFor(() => expect(result.current.abortError).toBeNull())
  })

  // 终止请求失败时后端 agent 仍在跑（继续改文件、烧 token），界面却已翻成「已停止」。
  // 此前 agentAPI.abort(...).catch(() => {}) 把两种结局一并空吞。
  const renderStreamingWithAbortResponse = async (abortResponse: {
    status: number
    body: unknown
  }) => {
    const chunk = new TextEncoder().encode('data: {"_tag":"text_delta","text":"hi"}\n\n')
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
                return new Promise<{ done: boolean; value: undefined }>(() => {})
              },
            }),
          },
        }
      }
      const text = JSON.stringify(abortResponse.body)
      return {
        ok: abortResponse.status < 400,
        status: abortResponse.status,
        json: async () => JSON.parse(text),
        text: async () => text,
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)

    const { result } = renderHook(() => useChat('s1'), { wrapper })
    await act(async () => {
      void result.current.sendMessage('hi')
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(result.current.isStreaming).toBe(true)

    await act(async () => {
      result.current.abort()
    })
    return { result, fetchMock }
  }

  it('终止请求 500 → abortError 给出原因，不静默', async () => {
    const { result } = await renderStreamingWithAbortResponse({
      status: 500,
      body: { error: { message: 'boom' } },
    })

    expect(result.current.isStreaming).toBe(false)
    await waitFor(() => expect(result.current.abortError).toContain('终止请求失败'))
    // 关键：不是「看起来停了」，而是明说 agent 可能还在后台跑
    expect(result.current.abortError).toContain('后台')
  })

  it('后端回 {aborted:false} → abortError 说明没有可终止的运行', async () => {
    const { result } = await renderStreamingWithAbortResponse({
      status: 200,
      body: { aborted: false },
    })

    await waitFor(() => expect(result.current.abortError).toContain('终止没有送达'))
  })

  it('终止成功后 abortError 复位（重试成功不留旧原因）', async () => {
    const { result } = await renderStreamingWithAbortResponse({
      status: 500,
      body: { error: { message: 'boom' } },
    })
    await waitFor(() => expect(result.current.abortError).toContain('终止请求失败'))

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const text = JSON.stringify({ aborted: true })
        return {
          ok: true,
          status: 200,
          json: async () => ({ aborted: true }),
          text: async () => text,
        }
      }),
    )
    await act(async () => {
      result.current.abort()
    })
    await waitFor(() => expect(result.current.abortError).toBeNull())
  })

  // 回归：终止后「终止」按钮消失（同屏已宣布运行停止），在途工具卡却永远停在
  // ⏳「执行中」——服务端的 aborted 结果要等下一次重取消息才送达，中间这段空窗里
  // 界面自相矛盾，用户不知道那次 bash/git 到底还在不在跑。
  it('终止时在途工具被封口成失败，不留在 ⏳「执行中」', async () => {
    const sse =
      'data: {"_tag":"tool_call_start","id":"tc1","tool":"bash","input":{"command":"sleep 300"}}\n\n'
    const chunk = new TextEncoder().encode(sse)
    let readIdx = 0
    const fetchMock = vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
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
                // 挂起直到 signal 被终止——真实 fetch 的 reader 在 abort 时抛错，
                // 这里必须同样抛，否则 doStream 永远停在 try 里，收尾分支走不到。
                return await new Promise<never>((_, reject) => {
                  const signal = init?.signal
                  if (!signal) return
                  const fail = (): void => reject(new Error('Aborted'))
                  if (signal.aborted) fail()
                  else signal.addEventListener('abort', fail, { once: true })
                })
              },
            }),
          },
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ aborted: true }),
        text: async () => JSON.stringify({ aborted: true }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    const { result } = renderHook(() => useChat('s1'), { wrapper })

    await act(async () => {
      void result.current.sendMessage('hi')
      await new Promise((r) => setTimeout(r, 50))
    })
    // 在途：已有 tool_call、没有 tool_result
    await waitFor(() =>
      expect(
        result.current.messages.some((m) => m.content.some((p) => p._tag === 'tool_call')),
      ).toBe(true),
    )

    await act(async () => {
      result.current.abort()
      await new Promise((r) => setTimeout(r, 50))
    })

    const parts = result.current.messages.flatMap((m) => m.content)
    expect(parts.some((p) => p._tag === 'tool_call' && p.id === 'tc1')).toBe(true)
    const settled = parts.find((p) => p._tag === 'tool_result' && p.id === 'tc1')
    expect(settled).toBeDefined()
    expect(settled && settled._tag === 'tool_result' ? settled.output._tag : null).toBe('error')
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
        text: async () =>
          JSON.stringify({ error: { code: 'RUN_ACTIVE', message: '已有进行中的对话' } }),
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

// 回归（审查 #3）：RUN_ACTIVE 与 WORKTREE_MISSING/PROJECT_MISSING 分支此前把
// lastFailureRef 写在 setState 更新器函数体内——更新器延迟到重渲染才执行，而
// ChatSession 的 cleanupEmptySessionOnFailure 在 sendMessage 的 .then 微任务里读
// chatRef.current.lastFailure.current，读点时机无保证，命中时草稿页横幅退化为兜底
// 文案「消息发送失败，请重试后再次发送」。相邻分支（PROVIDER_NOT_FOUND 等）都在
// setState 之前同步写 ref。这里在 sendMessage promise 兑现的微任务里（React
// 重渲染之前）读 ref，钉住同样的写入时机。
describe('useChat 失败原因的写入时机', () => {
  afterEach(() => vi.restoreAllMocks())

  function renderChat() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    return renderHook(() => useChat('s1'), { wrapper })
  }

  function stubHttpError(status: number, code: string, message: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status,
        json: async () => ({ error: { code, message } }),
        text: async () => JSON.stringify({ error: { code, message } }),
      })),
    )
  }

  /** sendMessage promise 兑现即读 ref：这一拍在 React 重渲染（setState 更新器
   *  执行）之前——正是 cleanupEmptySessionOnFailure 读 ref 的时机。 */
  async function sendAndCaptureFailure(result: { current: ReturnType<typeof useChat> }) {
    return result.current.sendMessage('hi').then(() => result.current.lastFailure.current)
  }

  it('RUN_ACTIVE：失败原因在 sendMessage 兑现时已写入 ref，不等重渲染', async () => {
    stubHttpError(409, 'RUN_ACTIVE', '已有进行中的对话')
    const { result } = renderChat()
    const failureAtCatch = await act(async () => sendAndCaptureFailure(result))
    expect(failureAtCatch?.reason).toBe('该会话已有进行中的对话')
  })

  it('WORKTREE_MISSING：失败原因在 sendMessage 兑现时已写入 ref，不等重渲染', async () => {
    stubHttpError(409, 'WORKTREE_MISSING', '会话的工作目录不存在，请先恢复或重新绑定')
    const { result } = renderChat()
    const failureAtCatch = await act(async () => sendAndCaptureFailure(result))
    expect(failureAtCatch?.reason).toBe('会话的工作目录不存在，请先恢复或重新绑定')
  })
})

// 回归：白名单外的服务端 HTTP 错误此前统统落进「网络错误视为中断」——顶栏错误位
// 空白、横幅谎报服务重启、乐观 user 消息留在时间线上，而「恢复对话」只是重发同一
// 请求、必然再次失败。这里钉死「服务端错误 → 透出后端文案 + 撤回乐观消息」，
// 同时保住「真网络故障 → 中断」这一条。
describe('useChat 服务端错误分类', () => {
  afterEach(() => vi.restoreAllMocks())

  function renderChat() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    return renderHook(() => useChat('s1'), { wrapper })
  }

  function stubHttpError(status: number, code: string, message: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status,
        json: async () => ({ error: { code, message } }),
        text: async () => JSON.stringify({ error: { code, message } }),
      })),
    )
  }

  it('RUN_STARTING（409）透出后端文案、撤回乐观 user 消息、不标记中断', async () => {
    stubHttpError(409, 'RUN_STARTING', '该会话的对话正在启动，请稍后重试')
    const { result } = renderChat()
    await act(async () => {
      await result.current.sendMessage('hi')
    })
    expect(result.current.error).toBe('该会话的对话正在启动，请稍后重试')
    expect(result.current.messages.some((m) => m.role === 'user')).toBe(false)
    expect(result.current.interrupted).toBe(false)
  })

  it('404 会话已删除：给出后端的可恢复提示，而不是「服务可能已重启」', async () => {
    stubHttpError(404, 'NOT_FOUND', '会话不存在或已删除（如需继续对话请先从回收站恢复）')
    const { result } = renderChat()
    await act(async () => {
      await result.current.sendMessage('hi')
    })
    expect(result.current.error).toBe('会话不存在或已删除（如需继续对话请先从回收站恢复）')
    expect(result.current.interrupted).toBe(false)
  })

  it('401 认证失效：透出带操作指引的文案（从 serve 输出的 URL 重新进入）', async () => {
    stubHttpError(401, 'UNAUTHORIZED', '认证失败')
    const { result } = renderChat()
    await act(async () => {
      await result.current.sendMessage('hi')
    })
    expect(result.current.error).toContain('认证失败')
    expect(result.current.error).toContain('serve 输出的 URL')
    expect(result.current.interrupted).toBe(false)
  })

  it('真网络故障（fetch reject，无 status）仍视为连接中断', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const { result } = renderChat()
    await act(async () => {
      await result.current.sendMessage('hi')
    })
    expect(result.current.interrupted).toBe(true)
    expect(result.current.error).toBeNull()
  })

  // retry（重试 / 恢复对话）不追加 user 消息。撤回逻辑此前按「最后一条是 user 就
  // pop」执行，对重发同样生效——一次 404/500 的重发失败会把一条**已落库**的历史
  // 消息从时间线上抹掉，而 messages 查询早于落库取过，不会自动补回，
  // 「重试」按钮也再也救不回来。
  it('重发失败不得撤掉不属于本次的已落库消息', async () => {
    stubHttpError(404, 'NOT_FOUND', '会话不存在或已删除')
    const { result } = renderChat()
    // 先成功发一条（落库且留在时间线上）
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => ({ done: true, value: undefined }),
            cancel: async () => {},
          }),
        },
        text: async () => '',
      })),
    )
    await act(async () => {
      await result.current.sendMessage('已落库的那条')
    })
    const persisted = result.current.messages.filter((m) => m.role === 'user')
    expect(persisted).toHaveLength(1)

    // 再走 retry（不追加消息）并让它失败
    stubHttpError(404, 'NOT_FOUND', '会话不存在或已删除')
    await act(async () => {
      await result.current.retry('已落库的那条')
    })

    // 错误照常透出，但那条已落库的用户消息必须还在
    expect(result.current.error).toBe('会话不存在或已删除')
    expect(result.current.messages.filter((m) => m.role === 'user')).toHaveLength(1)
  })
})

// 回归（P1 人机文件协作）：write/edit 工具结束 → 失效对应文件的预览/编辑器查询。
// 此前全库无任何 ['file'] invalidation——agent 改完文件后已打开的 FilePreview
// 永远陈旧，用户对着旧内容保存还会盲写覆盖（冲突检测由 CodeEditor 兜底）。
describe('useChat 文件视图失效（P1）', () => {
  afterEach(() => vi.restoreAllMocks())

  function makeSseFetch(events: string[]): ReturnType<typeof vi.fn> {
    const sse = events.map((e) => `data: ${e}\n\n`).join('')
    const chunk = new TextEncoder().encode(sse)
    let readIdx = 0
    return vi.fn(async () => ({
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
    }))
  }

  it('write 工具 tool_call_end → invalidateQueries ["file", path]（前缀命中所有 projectId 变体）', async () => {
    vi.stubGlobal(
      'fetch',
      makeSseFetch([
        '{"_tag":"tool_call_start","id":"t1","tool":"write","input":{"path":"src/a.ts","content":"x"}}',
        '{"_tag":"tool_call_end","id":"t1","result":{"_tag":"success","output":"ok"}}',
        '{"_tag":"done"}',
      ]),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)

    const { result } = renderHook(() => useChat('s1'), { wrapper })
    await act(async () => {
      await result.current.sendMessage('hi')
    })

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['file', 'src/a.ts'] })
  })

  it('read 等非文件变更工具不触发文件失效', async () => {
    vi.stubGlobal(
      'fetch',
      makeSseFetch([
        '{"_tag":"tool_call_start","id":"t1","tool":"read","input":{"path":"src/a.ts"}}',
        '{"_tag":"tool_call_end","id":"t1","result":{"_tag":"success","output":"ok"}}',
        '{"_tag":"done"}',
      ]),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)

    const { result } = renderHook(() => useChat('s1'), { wrapper })
    await act(async () => {
      await result.current.sendMessage('hi')
    })

    const fileInvalidations = invalidateSpy.mock.calls.filter(
      ([arg]) => Array.isArray(arg?.queryKey) && arg.queryKey[0] === 'file',
    )
    expect(fileInvalidations).toHaveLength(0)
  })
})

// 回归（P1 后台附着）：附着轮询此前把「非 running」一律当作 run 结束——
// run 进入 paused（权限确认超时/预算超支暂停）时走 finishAttach：附着态清空、
// runPaused 从未置位。而「恢复」入口要求 runPaused && isStreaming、冷启动暂停
// 横幅只在挂载时判定一次——该标签页于是既看不到恢复入口，发送新消息又撞
// 409 RUN_ACTIVE（run 仍注册在服务端），会话在本页锁死到手动刷新为止。
describe('useChat 附着轮询的暂停态（P1）', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function statusFetch(
    statuses: Array<Record<string, unknown>>,
    pending: Record<string, unknown> | null = null,
  ): ReturnType<typeof vi.fn> {
    let idx = 0
    return vi.fn(async (url: string) => {
      if (String(url).includes('/status')) {
        const body = statuses[Math.min(idx, statuses.length - 1)]
        idx++
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => JSON.stringify(body),
        }
      }
      // 挂起权限查询等其余请求
      return {
        ok: true,
        status: 200,
        json: async () => ({ pending }),
        text: async () => JSON.stringify({ pending }),
      }
    })
  }

  // 回归：附着入口（冷启动挂载 / 跨标签页广播触发的 attach）此前只认 running——
  // run 已 paused（权限确认挂起/预算超支）时直接放弃：runPaused 从未置位（无「恢复」
  // 入口）、挂起权限弹窗不重挂、run 结束广播也被忽略（attachedRef 未置位）。
  // 该页发新消息撞 409 RUN_ACTIVE，锁死到手动刷新。pollAttachedRun 已修 paused，
  // 入口判定是同一修复漏掉的兄弟面。
  it('attach 时 run 已 paused → 进入暂停态并重挂权限弹窗，恢复后继续轮询', async () => {
    vi.useFakeTimers()
    // 调用序：attach 首次查询 paused（挂起权限）→ tick1 running（已恢复）→ tick2 idle
    vi.stubGlobal(
      'fetch',
      statusFetch(
        [{ _tag: 'paused', pauseReason: '权限确认挂起' }, { _tag: 'running' }, { _tag: 'idle' }],
        { toolCallId: 'tc-1', tool: 'write', input: { path: 'a.ts' } },
      ),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)

    const { result } = renderHook(() => useChat('s1'), { wrapper })
    await act(async () => {
      await result.current.attach()
    })
    // 暂停态：恢复入口可见（runPaused && isStreaming），非「运行中」附着横幅
    expect(result.current.isStreaming).toBe(true)
    expect(result.current.runPaused).toBe(true)
    expect(result.current.runPauseReason).toBe('权限确认挂起')
    expect(result.current.attachedRun).toBe(false)
    // 挂起权限弹窗重挂（用户确认后 run 才能继续）
    expect(result.current.pendingPermission?.toolCallId).toBe('tc-1')

    // 暂停期间仍在轮询：恢复后下一 tick 看到 running → 清暂停态、转运行中附着
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100)
    })
    expect(result.current.runPaused).toBe(false)
    expect(result.current.attachedRun).toBe(true)

    // run 结束 → 正常收尾
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(result.current.isStreaming).toBe(false)
    expect(result.current.attachedRun).toBe(false)
  })

  it('attach 时无活跃 run（idle）→ 不进入附着态', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', statusFetch([{ _tag: 'idle' }]))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)

    const { result } = renderHook(() => useChat('s1'), { wrapper })
    await act(async () => {
      await result.current.attach()
    })
    expect(result.current.isStreaming).toBe(false)
    expect(result.current.attachedRun).toBe(false)
    expect(result.current.runPaused).toBe(false)
  })

  // 回归：附着轮询把 interrupted（服务重启，run 内存态已丢）也当普通结束——
  // 附着态静默清空、无任何恢复提示；「上次对话被中断」横幅只在冷启动判定一次，
  // 附着期间发生的中断对该页永远不可见。
  it('附着期间 run 被服务重启中断 → 停止轮询并展示中断恢复入口', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', statusFetch([{ _tag: 'running' }, { _tag: 'interrupted' }]))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)

    const { result } = renderHook(() => useChat('s1'), { wrapper })
    await act(async () => {
      await result.current.attach()
    })
    expect(result.current.attachedRun).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(result.current.isStreaming).toBe(false)
    expect(result.current.attachedRun).toBe(false)
    expect(result.current.interrupted).toBe(true)
  })

  it('附着期间 run 暂停 → 保留「恢复」入口（runPaused + isStreaming）并继续轮询到结束', async () => {
    vi.useFakeTimers()
    // 调用序：attach 首次查询 running → 轮询 tick1 paused → tick2 running（已恢复）
    // → tick3 idle（run 结束）
    vi.stubGlobal(
      'fetch',
      statusFetch([
        { _tag: 'running' },
        { _tag: 'paused', pauseReason: '预算超支：本月已达上限' },
        { _tag: 'running' },
        { _tag: 'idle' },
      ]),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)

    const { result } = renderHook(() => useChat('s1'), { wrapper })
    await act(async () => {
      await result.current.attach()
    })
    expect(result.current.attachedRun).toBe(true)
    expect(result.current.isStreaming).toBe(true)

    // 首个轮询 tick（2s 后）读到 paused
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(result.current.runPaused).toBe(true)
    expect(result.current.runPauseReason).toBe('预算超支：本月已达上限')
    // 恢复入口可见的前提：isStreaming 保持 true（ChatSession 的暂停横幅条件）
    expect(result.current.isStreaming).toBe(true)

    // 暂停期间仍在轮询：下一 tick 看到 running（用户已恢复）→ 清暂停态
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100)
    })
    expect(result.current.runPaused).toBe(false)
    expect(result.current.isStreaming).toBe(true)

    // run 结束 → 正常收尾
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(result.current.isStreaming).toBe(false)
    expect(result.current.attachedRun).toBe(false)
  })

  it('卸载后停止附着轮询（不再发出 status 请求）', async () => {
    vi.useFakeTimers()
    const fetchMock = statusFetch([{ _tag: 'running' }])
    vi.stubGlobal('fetch', fetchMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)

    const { result, unmount } = renderHook(() => useChat('s1'), { wrapper })
    await act(async () => {
      await result.current.attach()
    })
    const callsBefore = fetchMock.mock.calls.filter(([u]) => String(u).includes('/status')).length
    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    const callsAfter = fetchMock.mock.calls.filter(([u]) => String(u).includes('/status')).length
    expect(callsAfter).toBe(callsBefore)
  })
})

/**
 * 回归：附着页看不到运行期新出现的权限请求。
 *
 * 附着页没有本次 run 的 SSE 流（permission_required 事件只送得到发起流的标签页），
 * 权限请求只能从 GET /:id/pending 读到。此前 attach() 只在进入附着态那一刻查一次
 * ——查询之后才发起的工具权限请求，该页永远不弹确认弹窗：run 停在那里等一个用户
 * 看不到的决定，直到服务端 5 分钟提示 / 25 分钟宽限超时自动拒绝；界面全程只有
 * 「运行中…」，用户只会当成模型卡住。（另：那一刻的查询自身失败也被 .catch 吞掉，
 * 同一条修复顺带覆盖。）
 */
describe('useChat 附着轮询复查挂起权限（P1）', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** /status 与 /pending 按同一个调用序号取值：pendings[i] 是第 i 次 /status 之后
   *  那次 /pending 的结果（attach 的那一对是 i = 0）。 */
  function statusFetchSeq(
    statuses: Array<Record<string, unknown>>,
    pendings: Array<Record<string, unknown> | null>,
  ): ReturnType<typeof vi.fn> {
    let idx = 0
    const json = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
    return vi.fn(async (url: string) => {
      if (String(url).includes('/status')) {
        const body = statuses[Math.min(idx, statuses.length - 1)]
        idx++
        return json(body)
      }
      return json({ pending: pendings[Math.min(idx - 1, pendings.length - 1)] ?? null })
    })
  }

  async function renderAttached() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    const { result } = renderHook(() => useChat('s1'), { wrapper })
    await act(async () => {
      await result.current.attach()
    })
    expect(result.current.isStreaming).toBe(true)
    return result
  }

  it('附着期间新出现的权限请求 → 轮询复查后弹出确认弹窗', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      statusFetchSeq(
        [{ _tag: 'running' }],
        [null, { toolCallId: 'tc-9', tool: 'bash', input: { cmd: 'ls' } }],
      ),
    )
    const result = await renderAttached()
    // attach 那一刻还没有挂起请求
    expect(result.current.pendingPermission).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(result.current.pendingPermission?.toolCallId).toBe('tc-9')
  })

  it('本页确认后轮询不会把同一请求重新弹回来', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      statusFetchSeq(
        [{ _tag: 'running' }],
        [
          { toolCallId: 'tc-9', tool: 'bash', input: {} },
          { toolCallId: 'tc-9', tool: 'bash', input: {} },
        ],
      ),
    )
    vi.spyOn(agentAPI, 'confirmTool').mockResolvedValue({ confirmed: true })
    const result = await renderAttached()
    expect(result.current.pendingPermission?.toolCallId).toBe('tc-9')

    await act(async () => {
      result.current.confirm('tc-9', true)
    })
    expect(result.current.pendingPermission).toBeNull()

    // store 的消费还在路上（仍是 tc-9）：复查不得把它重新弹回来
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(result.current.pendingPermission).toBeNull()
  })

  it('他页已给出决定（store 不再挂起）→ 轮询收起弹窗', async () => {
    vi.useFakeTimers()
    const pending = { toolCallId: 'tc-9', tool: 'bash', input: {} }
    vi.stubGlobal('fetch', statusFetchSeq([{ _tag: 'running' }], [pending, pending, null]))
    const result = await renderAttached()
    expect(result.current.pendingPermission?.toolCallId).toBe('tc-9')

    // tick1：store 仍有挂起 → 保留
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(result.current.pendingPermission?.toolCallId).toBe('tc-9')

    // tick2：store 已无挂起（他页确认/拒绝，或宽限超时自动拒绝）→ 收起弹窗，
    // 否则用户对着一个已失效的请求点确认只会拿到 404。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(result.current.pendingPermission).toBeNull()
  })
})

/**
 * 追加指令（steer）的送达语义。
 *
 * 缺陷：POST /api/chat/steer 的 200 不等于受理——没有进行中的 run 时它回
 * {steered:false}，指令既没注入 run 也没落库。此前 steer 从不读响应体、失败只
 * console，却照样在时间线追加乐观 steering 条目：用户看到一条「已送达」的指令，
 * 刷新后它消失，agent 从未收到；调用方还会据此清空输入框。两种结局都让用户
 * 无从判断自己的指令到底发没发出去。
 */
describe('useChat steer 的送达语义', () => {
  afterEach(() => vi.restoreAllMocks())

  /** 附着到一个仍在运行的 run：走 attach() 拿到流式态（不自己开 SSE 流）。 */
  async function renderStreaming() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = String(url).includes('/status') ? { _tag: 'running' } : { pending: null }
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => JSON.stringify(body),
        }
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    const { result } = renderHook(() => useChat('s1'), { wrapper })
    await act(async () => {
      await result.current.attach()
    })
    expect(result.current.isStreaming).toBe(true)
    return result
  }

  it('后端回 steered:false 时不追加乐观条目，并给出原因', async () => {
    const result = await renderStreaming()
    vi.spyOn(agentAPI, 'steer').mockResolvedValue({ steered: false })

    let delivered: boolean | undefined
    await act(async () => {
      delivered = await result.current.steer('改用 pnpm')
    })

    expect(delivered).toBe(false)
    expect(
      result.current.messages.some((m) => JSON.stringify(m.content).includes('改用 pnpm')),
    ).toBe(false)
    expect(result.current.error).toMatch(/追加指令未送达/)
  })

  it('受理成功后追加 steering 条目', async () => {
    const result = await renderStreaming()
    vi.spyOn(agentAPI, 'steer').mockResolvedValue({ steered: true })

    let delivered: boolean | undefined
    await act(async () => {
      delivered = await result.current.steer('改用 pnpm')
    })

    expect(delivered).toBe(true)
    expect(
      result.current.messages.some((m) =>
        m.content.some((p) => p._tag === 'steering' && p.text === '改用 pnpm'),
      ),
    ).toBe(true)
  })

  it('请求失败时透出原因且不谎报已送达', async () => {
    const result = await renderStreaming()
    vi.spyOn(agentAPI, 'steer').mockRejectedValue(new Error('连接已中断'))

    let delivered: boolean | undefined
    await act(async () => {
      delivered = await result.current.steer('改用 pnpm')
    })

    expect(delivered).toBe(false)
    expect(result.current.error).toContain('连接已中断')
    expect(
      result.current.messages.some((m) =>
        m.content.some((p) => p._tag === 'steering' && p.text === '改用 pnpm'),
      ),
    ).toBe(false)
  })
})

/**
 * 切换会话时在飞的流必须作废。
 *
 * 缺陷：ChatSession 在 /projects/:p/sessions/:a → :b 之间被路由复用（route.path
 * 不变，子树不重建），sessionId 变化的 effect 只 stopPoll + setState(INITIAL)，
 * **没有作废在飞的 SSE 流**——上一条会话的 onEvent 闭包继续 setState，把 A 的
 * 正文/工具卡写进刚复位成 INITIAL 的 state，经 mergeSessionMessages 渲染成
 * 「B 的时间线里出现 A 的回复」；B 顶部还挂着「运行中」，点「终止」也停不掉 A
 * （abortRef 已被 B 的流覆盖）。也不能靠 abort fetch 解决：服务端把 SSE 断开
 * 当作「用户终止」（stream.onAbort → agentManager.abort），会连带杀掉后台 run，
 * 与「离开会话后 run 继续跑、回来 attach 重挂」的设计冲突。
 */
describe('useChat 切换会话作废在飞的流', () => {
  afterEach(() => vi.restoreAllMocks())

  it('切会话后旧会话的后续帧不再写进新会话', async () => {
    const enc = new TextEncoder()
    // 可控 SSE 流：测试显式喂帧，读到帧之后才继续读
    let resolveRead: ((v: { done: boolean; value?: Uint8Array }) => void) | null = null
    const read = () =>
      new Promise<{ done: boolean; value?: Uint8Array }>((res) => (resolveRead = res))
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/chat') {
        return { ok: true, status: 200, body: { getReader: () => ({ read }) } }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => '{"ok":true}',
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    const { result, rerender } = renderHook(({ id }: { id: string }) => useChat(id), {
      initialProps: { id: 's1' },
      wrapper,
    })

    // 会话 A 起流（不 await：reader 阻塞在下一帧）
    await act(async () => {
      void result.current.sendMessage('hi')
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(result.current.isStreaming).toBe(true)

    /** 把一帧喂进流并等 React 消化。 */
    const emit = async (event: unknown) => {
      await waitFor(() => expect(resolveRead).not.toBeNull())
      const res = resolveRead as ((v: { done: boolean; value?: Uint8Array }) => void) | null
      resolveRead = null
      await act(async () => {
        res?.({ done: false, value: enc.encode(`data: ${JSON.stringify(event)}\n\n`) })
        await new Promise((r) => setTimeout(r, 20))
      })
    }

    // A 自己收到帧：正常归约
    await emit({ _tag: 'text_delta', text: 'A 的回复' })
    expect(
      result.current.messages.some((m) => JSON.stringify(m.content).includes('A 的回复')),
    ).toBe(true)

    // 切到会话 B：状态复位，A 的流仍在飞
    await act(async () => {
      rerender({ id: 's2' })
    })
    expect(result.current.messages).toHaveLength(0)
    expect(result.current.isStreaming).toBe(false)

    // A 的后续帧到达：必须被丢弃（修复前这里会渲染出 A 的正文）
    await emit({ _tag: 'text_delta', text: 'A 的后续' })
    expect(result.current.messages).toHaveLength(0)
    expect(JSON.stringify(result.current.messages)).not.toContain('A 的后续')
  })
})
