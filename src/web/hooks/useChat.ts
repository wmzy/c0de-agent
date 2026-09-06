import type { AgentError, AgentEvent } from '@shared/types/agent.js'
import type { Message, MessageContent } from '@shared/types/message.js'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { agentAPI } from '../services/agent.js'
import { sendChatMessage } from '../services/chat.js'
import { permissionAPI } from '../services/permission.js'
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
  /** P2-9：权限确认超时（保持 pending，前端重开弹窗；不再重发消息）。 */
  permissionTimeout: { toolCallId: string; tool: string; input: unknown } | null
  /** 本轮派发的子 agent 进度（spec: multi-agent-design §4.5）。 */
  subagents: SubagentInfo[]
  /** 后端检测到模型/工具变更需用户确认开新段时设置；携带活跃段信息与待重发内容。 */
  pendingSegmentBreak: PendingSegmentBreak | null
  /** SSE 流中断（服务重启等）：true 时显示恢复提示。 */
  interrupted: boolean
  /** P1：后台附着——本组件实例未发起 SSE 流，但检测到会话有活跃 run
   *  （其他标签页启动 / 挂起期间切换页面后回来）。true 时显示运行态横幅。 */
  attachedRun: boolean
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
  /** 发送消息；返回 false = 本轮未正常完成（供调用方做首条失败清理）。 */
  sendMessage: (content: string, opts?: ChatOpts) => Promise<boolean>
  abort: () => void
  /** 确认/拒绝权限请求：乐观关闭弹窗并通知后端。
   *  alwaysAllowTool 非空时先把该工具加入会话白名单。 */
  confirm: (toolCallId: string, approved: boolean, alwaysAllowTool?: string) => void
  /** 用户确认开新段：withCompaction 时先压缩会话再重发。 */
  confirmBreak: (withCompaction: boolean) => Promise<void>
  /** 用户取消开新段：清除待发状态并移除乐观追加的 user 消息。 */
  cancelBreak: () => void
  /** 重试中断的对话：不追加 user 消息（已在 DB 中），直接发起 SSE 流。 */
  retry: (content: string, opts?: ChatOpts) => Promise<boolean>
  /** 权限确认超时后重新打开确认弹窗（不重发消息，工具只执行一次，P2-9）。 */
  reopenPermission: () => void
  /** 超时后拒绝该工具（显式终止 pending，run 继续）。 */
  denyTimedOutPermission: () => void
  /** 清除中断状态。 */
  clearInterrupted: () => void
  /** P1：附着后台 run——查询状态与挂起权限，重挂弹窗并轮询直到 run 结束。 */
  attach: () => Promise<void>
  reset: () => void
}

const INITIAL: ChatState = {
  messages: [],
  isStreaming: false,
  usage: null,
  error: null,
  pendingPermission: null,
  permissionTimeout: null,
  subagents: [],
  pendingSegmentBreak: null,
  interrupted: false,
  attachedRun: false,
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
    case 'heartbeat':
      // 服务端 30s 心跳（防 90s 静默看门狗误杀长工具/权限等待）；不产生任何 UI 变化。
      return state
    case 'permission_timeout':
      // P2-9：超时仅提示（store 保持 pending 等待显式确认/拒绝）。
      // 保留 input 供「重新询问」重开弹窗——不重发消息，工具只执行一次。
      return {
        ...state,
        pendingPermission: null,
        permissionTimeout: { toolCallId: event.toolCallId, tool: event.tool, input: event.input },
      }
    case 'error':
      return { ...state, error: errorToMessage(event.error) }
    case 'done':
      return { ...state, isStreaming: false, pendingPermission: null, attachedRun: false }
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

/** 跨标签页 run 状态频道（P1：同会话多标签页启动/结束广播，触发他页附着/刷新）。 */
const RUN_CHANNEL = 'c0de-run-state'
/** 本标签页唯一 id：BroadcastChannel 会把消息投递给同页的其他频道对象
 *  （仅排除投递对象本身），订阅侧据此忽略本页广播，避免自发自收。 */
const TAB_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)

type RunStateMessage = { from: string; sessionId: string; active: boolean }

function broadcastRunState(msg: Omit<RunStateMessage, 'from'>): void {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return
  try {
    const ch = new BroadcastChannel(RUN_CHANNEL)
    ch.postMessage({ ...msg, from: TAB_ID })
    ch.close()
  } catch {
    // BroadcastChannel 不可用：忽略（无跨标签页同步）
  }
}

export function useChat(sessionId: string): ChatState & ChatActions {
  const [state, setState] = useState<ChatState>(INITIAL)
  const abortRef = useRef<AbortController | null>(null)
  // P1 后台附着：流式/附着态镜像 + 轮询代数与定时器。
  const streamingRef = useRef(false)
  const attachedRef = useRef(false)
  const attachingRef = useRef(false)
  const pollGenRef = useRef(0)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 段切换确认待发内容（confirmBreak/cancelBreak 读取，避免闭包staleness）
  const pendingRef = useRef<PendingSegmentBreak | null>(null)
  const llmDetailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const qc = useQueryClient()

  /** 停止附着轮询（幂等：递增代数使在途 tick 失效）。 */
  const stopPoll = useCallback(() => {
    pollGenRef.current += 1
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  // 切换会话时重置本地流式状态；历史消息由调用方合并加载
  // P1：同时停止附着轮询并复位镜像 ref——挂起/附着态随会话切换整体作废。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅依赖 sessionId 触发重置
  useEffect(() => {
    stopPoll()
    streamingRef.current = false
    attachedRef.current = false
    attachingRef.current = false
    setState(INITIAL)
  }, [sessionId])

  // 执行 SSE 流并归约事件；捕获 409 SEGMENT_BREAK_REQUIRED 时存入 pendingSegmentBreak。
  // SSE 流未收到 done 事件结束时标记 interrupted（服务重启等）；
  // 但若已收到 error 事件，说明是服务端正常错误（LLM 报错等），不标记中断。
  // 返回 ok=false 表示本轮未正常完成（供调用方做首条消息失败清理等）。
  const doStream = useCallback(
    async (content: string, opts: ChatOpts | undefined): Promise<boolean> => {
      abortRef.current = new AbortController()
      // P1：标记流式态并广播 run 启动——同会话其他标签页据此附着显示运行态。
      streamingRef.current = true
      broadcastRunState({ sessionId, active: true })
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
            } else if (event._tag === 'todo_update') {
              // Tag-based todo 操作成功，刷新 TodoPanel（React Query 重新拉取）
              qc.invalidateQueries({ queryKey: ['todo', sessionId] })
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
        return result.done
      } catch (err) {
        const e = err as unknown as APIError
        if (e.code === 'RUN_ACTIVE') {
          // 并发守卫：撤回乐观追加的 user 消息并提示（P0-4）。
          setState((s) => {
            const msgs = [...s.messages]
            const last = msgs[msgs.length - 1]
            if (last && last.role === 'user') msgs.pop()
            return { ...s, messages: msgs, isStreaming: false, error: '该会话已有进行中的对话' }
          })
          return false
        }
        if (
          e.code === 'NO_PROVIDER_CONFIGURED' ||
          e.code === 'PROVIDER_NOT_FOUND' ||
          e.code === 'MODEL_NOT_FOUND'
        ) {
          // P0-1/P2-4：provider/模型配置问题 → 撤回乐观 user 消息并给出服务端可操作提示
          setState((s) => {
            const msgs = [...s.messages]
            const last = msgs[msgs.length - 1]
            if (last && last.role === 'user') msgs.pop()
            return {
              ...s,
              messages: msgs,
              isStreaming: false,
              error: e.message,
            }
          })
          return false
        }
        if (e.code === 'WORKTREE_MISSING' || e.code === 'PROJECT_MISSING') {
          setState((s) => {
            const msgs = [...s.messages]
            const last = msgs[msgs.length - 1]
            if (last && last.role === 'user') msgs.pop()
            return { ...s, messages: msgs, isStreaming: false, error: e.message }
          })
          return false
        }
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
          return false
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
        return false
      } finally {
        // P1：无论正常完成/错误/中止，广播 run 结束——他页附着者据此停止轮询刷新。
        streamingRef.current = false
        broadcastRunState({ sessionId, active: false })
      }
    },
    [sessionId, qc],
  )

  const sendMessage = useCallback(
    async (content: string, opts?: ChatOpts): Promise<boolean> => {
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
      return doStream(content, opts)
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
  // alwaysAllowTool：用户勾选「本会话始终允许」时，先追加会话白名单再确认。
  const confirm = useCallback(
    (toolCallId: string, approved: boolean, alwaysAllowTool?: string) => {
      setState((s) => ({ ...s, pendingPermission: null }))
      const doConfirm = () =>
        agentAPI.confirmTool(toolCallId, approved).catch((err) => {
          const e = err as { status?: number }
          if (e?.status === 404) {
            // 已被处理（其他标签页确认/拒绝）或 run 已中止：明确提示，避免「以为已批准」。
            // P3 文案修正：此前写「超过 5 分钟未确认」，但 P2-9 后交互式权限不再超时自动拒绝。
            setState((s) => ({
              ...s,
              error: '权限请求已被处理（可能在其他标签页确认/拒绝）或已中止，工具未执行',
            }))
          } else {
            console.error('[权限确认] 失败，工具调用可能已过期:', err)
          }
        })
      if (approved && alwaysAllowTool) {
        permissionAPI
          .setAlwaysAllow(alwaysAllowTool, sessionId)
          .catch(() => {
            console.error('[权限白名单] 追加失败:', alwaysAllowTool)
          })
          .finally(() => void doConfirm())
      } else {
        void doConfirm()
      }
    },
    [sessionId],
  )

  // 重试中断的对话：不追加 user 消息（已在 DB 中），直接发起 SSE 流。
  // 后端 runAgent 幂等检查会跳过重复 append。
  const retry = useCallback(
    async (content: string, opts?: ChatOpts): Promise<boolean> => {
      setState((s) => ({ ...s, isStreaming: true, error: null, interrupted: false }))
      return doStream(content, opts)
    },
    [doStream],
  )

  // P2-9：权限确认超时后重新打开确认弹窗——store 中 pending 仍在，
  // 把超时信息还原为 pendingPermission 即可，不重发消息、工具只执行一次。
  const reopenPermission = useCallback(() => {
    setState((s) => {
      if (!s.permissionTimeout) return s
      return {
        ...s,
        permissionTimeout: null,
        pendingPermission: {
          toolCallId: s.permissionTimeout.toolCallId,
          tool: s.permissionTimeout.tool,
          input: s.permissionTimeout.input,
        },
      }
    })
  }, [])

  /** 超时后显式拒绝：resolve store 中的 pending 为 deny，run 继续执行。 */
  const denyTimedOutPermission = useCallback(() => {
    setState((s) => {
      if (s.permissionTimeout) {
        const { toolCallId } = s.permissionTimeout
        agentAPI.confirmTool(toolCallId, false).catch(() => {})
      }
      return { ...s, permissionTimeout: null }
    })
  }, [])

  /** P1：附着结束——停止轮询、复位附着态并刷新消息/调用详情。 */
  const finishAttach = useCallback(() => {
    stopPoll()
    attachedRef.current = false
    streamingRef.current = false
    setState((s) => ({
      ...s,
      isStreaming: false,
      attachedRun: false,
      pendingPermission: null,
      permissionTimeout: null,
    }))
    qc.invalidateQueries({ queryKey: ['session', sessionId, 'messages'] })
    qc.invalidateQueries({ queryKey: ['session', sessionId, 'llm-details'] })
  }, [qc, sessionId, stopPoll])

  /** P1：附着轮询——每 2s 查状态，run 结束即刷新收尾。代数守卫防重复轮询。 */
  const pollAttachedRun = useCallback(() => {
    stopPoll()
    const token = ++pollGenRef.current
    const tick = async () => {
      if (token !== pollGenRef.current) return
      try {
        const st = await sessionAPI.status(sessionId)
        if (st?._tag === 'running') {
          if (token !== pollGenRef.current) return
          pollTimerRef.current = setTimeout(() => void tick(), 2000)
        } else {
          finishAttach()
        }
      } catch {
        if (token !== pollGenRef.current) return
        pollTimerRef.current = setTimeout(() => void tick(), 3000)
      }
    }
    pollTimerRef.current = setTimeout(() => void tick(), 2000)
  }, [finishAttach, sessionId, stopPoll])

  /**
   * P1：附着后台 run。本实例未发起流（挂起期间切换页面后回来 / 另一标签页启动）时：
   * 查状态确认 run 活跃 → 查询挂起权限并重挂确认弹窗（有则恢复阻塞的可操作路径）
   * → 进入附着态并轮询到 run 结束。本实例已在流式时 no-op。
   */
  const attach = useCallback(async () => {
    // attachingRef 同步占位：attach 内有 await，StrictMode/依赖变化下的重入
    // 若不拦截会并发多份查询与轮询。
    if (streamingRef.current || attachingRef.current) return
    attachingRef.current = true
    try {
      const st = await sessionAPI.status(sessionId).catch(() => null)
      if (st?._tag !== 'running') return
      const pend = await sessionAPI.pendingPermission(sessionId).catch(() => null)
      attachedRef.current = true
      streamingRef.current = true
      setState((s) => ({
        ...s,
        isStreaming: true,
        attachedRun: true,
        error: null,
        ...(pend?.pending ? { pendingPermission: pend.pending, permissionTimeout: null } : {}),
      }))
      pollAttachedRun()
    } finally {
      attachingRef.current = false
    }
  }, [pollAttachedRun, sessionId])

  // P1：订阅同会话其他标签页的 run 状态广播——他页启动时附着，结束时刷新收尾。
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const ch = new BroadcastChannel(RUN_CHANNEL)
    ch.onmessage = (ev: MessageEvent<RunStateMessage>) => {
      const msg = ev.data
      // 忽略本页广播（BroadcastChannel 同页多频道对象会互投）。
      if (!msg || msg.from === TAB_ID || msg.sessionId !== sessionId) return
      if (msg.active) {
        void attach()
      } else if (attachedRef.current) {
        finishAttach()
      }
    }
    return () => ch.close()
  }, [sessionId, attach, finishAttach])

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
    reopenPermission,
    denyTimedOutPermission,
    clearInterrupted,
    attach,
    reset,
  }
}

export type { ChatOpts, ChatState, SubagentInfo }
