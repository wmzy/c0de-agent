import type { AgentError, AgentEvent } from '@shared/types/agent.js'
import type { Message, MessageContent } from '@shared/types/message.js'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { agentAPI } from '../services/agent.js'
import { sendChatMessage } from '../services/chat.js'
import { sessionAPI } from '../services/session.js'
import type { APIError } from '../types/index.js'
import { generateId } from './id.js'

type SubagentInfo = {
  childId: string
  agentType: string
  description: string
  status: 'running' | 'completed' | 'failed'
}

type ChatState = {
  messages: Message[]
  isStreaming: boolean
  usage: { input: number; output: number } | null
  error: string | null
  pendingPermission: { toolCallId: string; tool: string; input: unknown } | null
  /** 本轮派发的子 agent 进度（spec: multi-agent-design §4.5）。 */
  subagents: SubagentInfo[]
  /** 后端检测到模型/工具变更需用户确认开新段时设置；携带活跃段信息与待重发内容。 */
  pendingSegmentBreak: PendingSegmentBreak | null
  /** SSE 流中断（服务重启等）：true 时显示恢复提示。 */
  interrupted: boolean
}

type PendingSegmentBreak = {
  activeSegment: { provider: string; model: string; tools: string[] }
  text: string
  opts: ChatOpts
}

type ChatOpts = {
  provider?: string
  model?: string
  tools?: string[]
  agent?: string
  agents?: string[]
  images?: Array<{ mediaType: string; data: string }>
  files?: string[]
  /** 用户确认开新段后重发时携带，跳过后端 409 预检。 */
  confirmSegmentBreak?: boolean
}

type ChatActions = {
  sendMessage: (content: string, opts?: ChatOpts) => Promise<void>
  abort: () => void
  /** 确认/拒绝权限请求：乐观关闭弹窗并通知后端。 */
  confirm: (toolCallId: string, approved: boolean) => void
  /** 用户确认开新段：withCompaction 时先压缩会话再重发。 */
  confirmBreak: (withCompaction: boolean) => Promise<void>
  /** 用户取消开新段：清除待发状态并移除乐观追加的 user 消息。 */
  cancelBreak: () => void
  /** 重试中断的对话：不追加 user 消息（已在 DB 中），直接发起 SSE 流。 */
  retry: (content: string, opts?: ChatOpts) => Promise<void>
  /** 清除中断状态。 */
  clearInterrupted: () => void
  reset: () => void
}

const INITIAL: ChatState = {
  messages: [],
  isStreaming: false,
  usage: null,
  error: null,
  pendingPermission: null,
  subagents: [],
  pendingSegmentBreak: null,
  interrupted: false,
}

/** 把 AgentEvent 归约到消息状态。纯函数，可单测。 */
export function reduceChatEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event._tag) {
    case 'text_delta': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') {
        const content = [...last.content]
        const lastPart = content[content.length - 1]
        if (lastPart && lastPart._tag === 'text') {
          content[content.length - 1] = { _tag: 'text', text: lastPart.text + event.text }
        } else {
          content.push({ _tag: 'text', text: event.text })
        }
        messages[messages.length - 1] = { ...last, content }
      } else {
        messages.push({
          id: generateId(),
          sessionId: '',
          role: 'assistant',
          content: [{ _tag: 'text', text: event.text }],
          tokenCount: 0,
          createdAt: Date.now(),
        })
      }
      return { ...state, messages }
    }
    case 'thinking': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') {
        const content = [...last.content]
        const lastPart = content[content.length - 1]
        if (lastPart && lastPart._tag === 'thinking') {
          content[content.length - 1] = { _tag: 'thinking', text: lastPart.text + event.text }
        } else {
          content.push({ _tag: 'thinking', text: event.text })
        }
        messages[messages.length - 1] = { ...last, content }
      } else {
        messages.push({
          id: generateId(),
          sessionId: '',
          role: 'assistant',
          content: [{ _tag: 'thinking', text: event.text }],
          tokenCount: 0,
          createdAt: Date.now(),
        })
      }
      return { ...state, messages }
    }
    case 'tool_call_start': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      const part: MessageContent = {
        _tag: 'tool_call',
        id: event.id,
        tool: event.tool,
        input: event.input,
      }
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = { ...last, content: [...last.content, part] }
      } else {
        messages.push({
          id: generateId(),
          sessionId: '',
          role: 'assistant',
          content: [part],
          tokenCount: 0,
          createdAt: Date.now(),
        })
      }
      return { ...state, messages }
    }
    case 'tool_call_end': {
      const messages = state.messages.map((m) => {
        if (m.role !== 'assistant') return m
        const hasCall = m.content.some((p) => p._tag === 'tool_call' && p.id === event.id)
        if (!hasCall) return m
        return {
          ...m,
          content: [
            ...m.content,
            {
              _tag: 'tool_result',
              id: event.id,
              tool: '',
              output: event.result,
            } as MessageContent,
          ],
        }
      })
      return { ...state, messages }
    }
    case 'usage':
      return { ...state, usage: { input: event.input, output: event.output } }
    case 'llm_detail':
      // 纯通知事件：调用详情由 useChat 在 onEvent 中 invalidate query 刷新，
      // 状态本身不变。
      return state
    case 'subagent_start': {
      const subagents = [
        ...state.subagents.filter((s) => s.childId !== event.childId),
        {
          childId: event.childId,
          agentType: event.agentType,
          description: event.description,
          status: 'running' as const,
        },
      ]
      return { ...state, subagents }
    }
    case 'subagent_progress':
      // 进度更新（工具名/状态）暂不改变状态，避免频繁重渲
      return state
    case 'subagent_end': {
      const subagents = state.subagents.map((s) =>
        s.childId === event.childId
          ? { ...s, status: (event.success ? 'completed' : 'failed') as 'completed' | 'failed' }
          : s,
      )
      return { ...state, subagents }
    }
    case 'permission_required':
      return {
        ...state,
        pendingPermission: { toolCallId: event.toolCallId, tool: event.tool, input: event.input },
      }
    case 'error':
      return { ...state, error: errorToMessage(event.error) }
    case 'done':
      return { ...state, isStreaming: false, pendingPermission: null }
    default:
      return state
  }
}

function errorToMessage(err: AgentError): string {
  switch (err._tag) {
    case 'aborted':
      return '已中止'
    case 'max_turns':
      return `达到最大轮数 ${err.maxTurns}`
    case 'unexpected':
      return err.message
    case 'provider':
      return err.message
    case 'tool':
      return `工具 ${err.toolName} 错误: ${err.message}`
  }
}

export function useChat(sessionId: string): ChatState & ChatActions {
  const [state, setState] = useState<ChatState>(INITIAL)
  const abortRef = useRef<AbortController | null>(null)
  // 段切换确认待发内容（confirmBreak/cancelBreak 读取，避免闭包staleness）
  const pendingRef = useRef<PendingSegmentBreak | null>(null)
  const llmDetailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const qc = useQueryClient()

  // 切换会话时重置本地流式状态；历史消息由调用方合并加载
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅依赖 sessionId 触发重置
  useEffect(() => {
    setState(INITIAL)
  }, [sessionId])

  // 执行 SSE 流并归约事件；捕获 409 SEGMENT_BREAK_REQUIRED 时存入 pendingSegmentBreak。
  // SSE 流未收到 done 事件结束时标记 interrupted（服务重启等）；
  // 但若已收到 error 事件，说明是服务端正常错误（LLM 报错等），不标记中断。
  const doStream = useCallback(
    async (content: string, opts: ChatOpts | undefined) => {
      abortRef.current = new AbortController()
      // 追踪是否收到 error 事件（区分服务端正常错误与连接中断）
      let gotError = false
      try {
        const result = await sendChatMessage(
          sessionId,
          content,
          (event) => {
            if (event._tag === 'error') gotError = true
            setState((s) => reduceChatEvent(s, event))
            // 收到调用详情通知时刷新调用详情面板，避免需手动刷新页面。
            // 高频 llm_detail 做 debounce（500ms），done/error 立即 flush。
            if (event._tag === 'llm_detail') {
              if (llmDetailTimerRef.current) clearTimeout(llmDetailTimerRef.current)
              llmDetailTimerRef.current = setTimeout(() => {
                qc.invalidateQueries({ queryKey: ['session', sessionId, 'llm-details'] })
              }, 500)
            } else if (event._tag === 'done' || event._tag === 'error') {
              if (llmDetailTimerRef.current) {
                clearTimeout(llmDetailTimerRef.current)
                llmDetailTimerRef.current = null
              }
              qc.invalidateQueries({ queryKey: ['session', sessionId, 'llm-details'] })
            }
          },
          abortRef.current.signal,
          opts,
        )
        if (!result.done && !gotError) {
          // SSE 结束但未收到 done 也无 error → 连接中断（服务重启等）
          setState((s) => ({ ...s, isStreaming: false, interrupted: true }))
        } else if (!result.done && gotError) {
          // 服务端正常错误（LLM 报错等），设 isStreaming=false 但不标记中断
          setState((s) => ({ ...s, isStreaming: false }))
        }
      } catch (err) {
        const e = err as unknown as APIError
        if (e.code === 'SEGMENT_BREAK_REQUIRED') {
          const details = e.details as
            | { activeSegment?: PendingSegmentBreak['activeSegment'] }
            | undefined
          const pending: PendingSegmentBreak = {
            activeSegment: details?.activeSegment ?? { provider: '', model: '', tools: [] },
            text: content,
            opts: opts ?? {},
          }
          pendingRef.current = pending
          setState((s) => ({ ...s, isStreaming: false, pendingSegmentBreak: pending }))
          return
        }
        // 网络错误（服务不可达）也视为中断
        if (!abortRef.current.signal.aborted) {
          setState((s) => ({ ...s, isStreaming: false, interrupted: true }))
        } else {
          if (llmDetailTimerRef.current) {
            clearTimeout(llmDetailTimerRef.current)
            llmDetailTimerRef.current = null
          }
          qc.invalidateQueries({ queryKey: ['session', sessionId, 'llm-details'] })
          setState((s) => ({ ...s, isStreaming: false }))
        }
      }
    },
    [sessionId, qc],
  )

  const sendMessage = useCallback(
    async (content: string, opts?: ChatOpts) => {
      const userMsg: Message = {
        id: generateId(),
        sessionId,
        role: 'user',
        content: [{ _tag: 'text', text: content }],
        tokenCount: 0,
        createdAt: Date.now(),
      }
      // 追加到已有消息（保留历史/多轮），仅重置 usage/error/permission
      setState((s) => ({ ...INITIAL, messages: [...s.messages, userMsg], isStreaming: true }))
      await doStream(content, opts)
    },
    [doStream, sessionId],
  )

  // 用户确认开新段：withCompaction 时先调压缩端点再重发（不重复追加 user 消息）。
  const confirmBreak = useCallback(
    async (withCompaction: boolean) => {
      const pending = pendingRef.current
      if (!pending) return
      pendingRef.current = null
      if (withCompaction) {
        try {
          await sessionAPI.compact(sessionId)
        } catch (err) {
          // 压缩失败不阻塞重发，记录错误便于排查
          console.error('[会话压缩] 失败:', err)
        }
      }
      setState((s) => ({ ...s, isStreaming: true, error: null, pendingSegmentBreak: null }))
      await doStream(pending.text, { ...pending.opts, confirmSegmentBreak: true })
    },
    [doStream, sessionId],
  )

  // 用户取消开新段：清除待发并移除乐观追加的 user 消息（selection/tools 还原由 ChatView 负责）。
  const cancelBreak = useCallback(() => {
    pendingRef.current = null
    setState((s) => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (msgs.length > 0 && last && last.role === 'user') msgs.pop()
      return { ...s, pendingSegmentBreak: null, isStreaming: false, messages: msgs }
    })
  }, [])

  const abort = useCallback(() => {
    abortRef.current?.abort()
    // 通知后端终止 agent，而不只是中断前端 SSE 读取。
    // 若仅 abort 前端 fetch，后端依赖 stream.onAbort 检测断开，可能有延迟或遗漏。
    agentAPI.abort(sessionId).catch(() => {})
    setState((s) => ({ ...s, isStreaming: false }))
  }, [sessionId])

  // 权限确认：乐观清空 pending，弹窗立即关闭。后端 store 的 pending 一次消费即删除，
  // 若不清空前端状态，弹窗会一直显示到 done 事件，期间用户重复点击会对已消费的
  // toolCallId 触发 404（"No pending permission"）。
  const confirm = useCallback((toolCallId: string, approved: boolean) => {
    setState((s) => ({ ...s, pendingPermission: null }))
    agentAPI
      .confirmTool(toolCallId, approved)
      .catch((err) => console.error('[权限确认] 失败，工具调用可能已过期:', err))
  }, [])

  // 重试中断的对话：不追加 user 消息（已在 DB 中），直接发起 SSE 流。
  // 后端 runAgent 幂等检查会跳过重复 append。
  const retry = useCallback(
    async (content: string, opts?: ChatOpts) => {
      setState((s) => ({ ...s, isStreaming: true, error: null, interrupted: false }))
      await doStream(content, opts)
    },
    [doStream],
  )

  const clearInterrupted = useCallback(() => {
    setState((s) => ({ ...s, interrupted: false }))
  }, [])

  const reset = useCallback(() => setState(INITIAL), [])

  return {
    ...state,
    sendMessage,
    abort,
    confirm,
    confirmBreak,
    cancelBreak,
    retry,
    clearInterrupted,
    reset,
  }
}

export type { ChatOpts, ChatState, SubagentInfo }
