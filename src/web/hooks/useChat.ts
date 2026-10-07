import type { Message, MessageContent } from '@shared/types/message.js'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  broadcastRunState,
  type ChatActions,
  type ChatOpts,
  type ChatState,
  INITIAL,
  type PendingSegmentBreak,
  type PendingTrust,
  RUN_CHANNEL,
  type RunStateMessage,
  reduceChatEvent,
  TAB_ID,
} from '@/hooks/chatState.js'
import { generateId } from '@/hooks/id.js'
import { agentAPI } from '@/services/agent.js'
import { sendChatMessage } from '@/services/chat.js'
import { permissionAPI } from '@/services/permission.js'
import { projectAPI } from '@/services/project.js'
import { sessionAPI } from '@/services/session.js'
import type { APIError } from '@/types/index.js'

/**
 * 连接中断的失败原因文案。两条 interrupted 路径（SSE 无 done 结束、fetch 本身失败）
 * 共用——它们对用户是同一件事：消息没发出去，且不知道服务是否还活着。
 */
const INTERRUPTED_REASON = '与服务的连接中断，消息未发出。请确认服务仍在运行后重试'

export function useChat(sessionId: string): ChatState & ChatActions {
  const [state, setState] = useState<ChatState>(INITIAL)
  const abortRef = useRef<AbortController | null>(null)
  // P1 后台附着：流式/权限超时态镜像——副作用（confirmTool 网络请求）必须
  // 在状态更新器之外发起：更新器是纯函数，StrictMode/并发渲染重放会重复
  // 执行，写进更新器会让同一拒绝请求发出两次。
  const permissionTimeoutRef = useRef<ChatState['permissionTimeout']>(null)
  permissionTimeoutRef.current = state.permissionTimeout
  // P1 后台附着：流式/附着态镜像 + 轮询代数与定时器。
  const streamingRef = useRef(false)
  const attachedRef = useRef(false)
  const attachingRef = useRef(false)
  const pollGenRef = useRef(0)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 段切换确认待发内容（confirmBreak/cancelBreak 读取，避免闭包staleness）
  const pendingRef = useRef<PendingSegmentBreak | null>(null)
  // P0-2：信任确认待发内容（confirmTrust/cancelTrust 读取）
  const pendingTrustRef = useRef<PendingTrust | null>(null)
  const llmDetailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * 最近一次 sendMessage 的失败原因。
   *
   * chat 对象是每次渲染新建的快照，调用方在自己的 .then 里读 chat.error 只能拿到
   * 发送**前**那一帧的 error（恒为 null）；要跨页面把原因带走（首条失败后清空会话
   * 回到草稿页），必须在这里同步落一份。
   */
  const failureReasonRef = useRef<string | null>(null)
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

  // 卸载时停止附着轮询：tick 链每轮自行续期，不清理的话组件卸载后仍会
  // 持续请求 /status（暂停态下 run 可长期挂着，链无自然终止点）。
  useEffect(() => stopPoll, [stopPoll])

  // 执行 SSE 流并归约事件；捕获 409 SEGMENT_BREAK_REQUIRED 时存入 pendingSegmentBreak。
  // SSE 流未收到 done 事件结束时标记 interrupted（服务重启等）；
  // 但若已收到 error 事件，说明是服务端正常错误（LLM 报错等），不标记中断。
  // 返回 ok=false 表示本轮未正常完成（供调用方做首条消息失败清理等）。
  const doStream = useCallback(
    async (content: string, opts: ChatOpts | undefined): Promise<boolean> => {
      abortRef.current = new AbortController()
      // P1：标记流式态并广播 run 启动——同会话其他标签页据此附着显示运行态。
      streamingRef.current = true
      // 新一轮开始：清掉上轮的失败原因
      failureReasonRef.current = null
      broadcastRunState({ sessionId, active: true })
      // 追踪是否收到 error 事件（区分服务端正常错误与连接中断）
      let gotError = false
      // P1 人机文件协作：记录进行中的 write/edit 调用（id → 文件路径），
      // tool_call_end 时失效对应文件的预览/编辑器查询——否则 agent 改完文件后，
      // 已打开的 FilePreview 永远陈旧（无任何 ['file'] invalidation），
      // 用户对着旧内容点保存还会盲写覆盖 agent 的修改（冲突检测在 CodeEditor 兜底）。
      // bash 等无法提取路径的写途径由编辑器保存时的磁盘比对兜底。
      const mutatingPaths = new Map<string, string>()
      try {
        const result = await sendChatMessage(
          sessionId,
          content,
          (event) => {
            if (event._tag === 'error') gotError = true
            if (
              event._tag === 'tool_call_start' &&
              (event.tool === 'write' || event.tool === 'edit')
            ) {
              const p = (event.input as { path?: unknown } | null)?.path
              if (typeof p === 'string' && p.length > 0) mutatingPaths.set(event.id, p)
            } else if (event._tag === 'tool_call_end') {
              const p = mutatingPaths.get(event.id)
              if (p !== undefined) {
                mutatingPaths.delete(event.id)
                // 前缀失效：['file', path] 命中所有 projectId 变体的查询键
                qc.invalidateQueries({ queryKey: ['file', p] })
              }
            }
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
          failureReasonRef.current = INTERRUPTED_REASON
          setState((s) => ({ ...s, isStreaming: false, interrupted: true }))
        } else if (!result.done && gotError) {
          // 服务端正常错误（LLM 报错等），设 isStreaming=false 但不标记中断
          setState((s) => ({ ...s, isStreaming: false }))
        }
        return result.done
      } catch (err) {
        const e = err as unknown as APIError
        // 撤回本轮**乐观追加**的那条 user 消息，且只撤这一条。
        //
        // 旧实现是「最后一条是 user 就 pop」——对 retry/confirmBreak/confirmTrust
        // 同样生效，可它们从不追加消息：一次 404/409/500/401 的重发失败会把一条
        // **已落库**的历史消息从时间线上抹掉（messages 查询早于落库取过，不会自动
        // 补回），而「重试」按钮也再也救不回来。sendMessage 传入 optimisticUserMessageId
        // 后，重发路径它是 undefined → 一条都不撤。
        const withdraw = (msgs: Message[]): Message[] => {
          const id = opts?.optimisticUserMessageId
          if (!id) return msgs
          const idx = msgs.findIndex((m) => m.id === id)
          return idx >= 0 ? msgs.filter((_, i) => i !== idx) : msgs
        }
        if (e.code === 'RUN_ACTIVE') {
          // 并发守卫：撤回乐观追加的 user 消息并提示（P0-4）。
          setState((s) => {
            const msgs = withdraw(s.messages)
            failureReasonRef.current = '该会话已有进行中的对话'
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
          failureReasonRef.current = e.message
          setState((s) => {
            const msgs = withdraw(s.messages)
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
            const msgs = withdraw(s.messages)
            failureReasonRef.current = e.message
            return { ...s, messages: msgs, isStreaming: false, error: e.message }
          })
          return false
        }
        if (e.code === 'TRUST_REQUIRED') {
          // P0-2：未信任项目的风险配置被后端拦截——保留乐观 user 消息，
          // 弹窗展示风险项；用户信任后按原内容重发。
          const details = e.details as
            | {
                projectId?: string
                projectName?: string
                items?: Array<{ kind?: string; detail?: string }>
              }
            | undefined
          const pending: PendingTrust = {
            projectId: typeof details?.projectId === 'string' ? details.projectId : '',
            projectName: typeof details?.projectName === 'string' ? details.projectName : '该项目',
            items: (details?.items ?? [])
              .filter((i) => i && typeof i.detail === 'string')
              .map((i) => ({
                kind: typeof i.kind === 'string' ? i.kind : 'unknown',
                detail: i.detail as string,
              })),
            text: content,
            opts: opts ?? {},
            ...(opts?.optimisticUserMessageId
              ? { optimisticUserMessageId: opts.optimisticUserMessageId }
              : {}),
          }
          pendingTrustRef.current = pending
          setState((s) => ({ ...s, isStreaming: false, pendingTrust: pending }))
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
            ...(opts?.optimisticUserMessageId
              ? { optimisticUserMessageId: opts.optimisticUserMessageId }
              : {}),
          }
          pendingRef.current = pending
          setState((s) => ({ ...s, isStreaming: false, pendingSegmentBreak: pending }))
          return false
        }
        if (abortRef.current.signal.aborted) {
          if (llmDetailTimerRef.current) {
            clearTimeout(llmDetailTimerRef.current)
            llmDetailTimerRef.current = null
          }
          qc.invalidateQueries({ queryKey: ['session', sessionId, 'llm-details'] })
          setState((s) => ({ ...s, isStreaming: false }))
        } else if (typeof e.status === 'number') {
          // 服务端 HTTP 错误（带 status）：后端已经给出可操作文案，这不是「连接中断」。
          // 上面各 code 分支只覆盖 8 种已知错误，其余——404 会话不存在或已删除、
          // 409 RUN_STARTING、400 INVALID_AGENT / 图片校验失败、401 认证失效、
          // 500 CWD_RESOLVE_FAILED——此前全部落入「网络错误视为中断」：顶栏错误位
          // 空白，横幅谎报「服务可能已重启」，乐观 user 消息留在时间线上，而
          // 「恢复对话」只是重发同一请求、必然再次失败，用户被困在错误的诊断里。
          // 与各 code 分支同口径：撤回乐观消息 + 透出后端文案（含重试入口）。
          const reason = e.message || `请求失败（HTTP ${e.status}）`
          failureReasonRef.current = reason
          setState((s) => {
            const msgs = withdraw(s.messages)
            return {
              ...s,
              messages: msgs,
              isStreaming: false,
              error: reason,
            }
          })
        } else {
          // 无 status：fetch 本身失败（服务不可达）或请求在途被打断 → 视为中断
          failureReasonRef.current = INTERRUPTED_REASON
          setState((s) => ({ ...s, isStreaming: false, interrupted: true }))
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
      // 乐观副本必须包含图片 part：签名比对靠 content，缺了图片就会与持久化
      // 副本配不上对，历史重取后同一条消息在时间线上重复出现两份。
      // 服务端按 body.images 落库为 image part（server/routes/chat.ts）。
      const parts: MessageContent[] = [{ _tag: 'text', text: content }]
      for (const img of opts?.images ?? []) {
        parts.push({ _tag: 'image', mediaType: img.mediaType, data: img.data })
      }
      const userMsg: Message = {
        id: generateId(),
        sessionId,
        role: 'user',
        content: parts,
        tokenCount: 0,
        createdAt: Date.now(),
      }
      // 追加到已有消息（保留历史/多轮），仅重置 usage/error/permission
      setState((s) => ({ ...INITIAL, messages: [...s.messages, userMsg], isStreaming: true }))
      // 把刚追加的 id 交给 doStream：失败时只撤回这一条（retry 等不追加消息的路径
      // 不传 id，于是不会误删已落库的历史消息——见 doStream 里的 withdraw）。
      return doStream(content, { ...opts, optimisticUserMessageId: userMsg.id })
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
      await doStream(pending.text, {
        ...pending.opts,
        confirmSegmentBreak: true,
        // 乐观消息仍在时间线上（待确认路径保留它），失败时仍要能精确撤回这一条
        ...(pending.optimisticUserMessageId
          ? { optimisticUserMessageId: pending.optimisticUserMessageId }
          : {}),
      })
    },
    [doStream, sessionId],
  )

  // 用户取消开新段：清除待发并移除触发它的乐观 user 消息（selection/tools 还原由
  // ChatView 负责）。撤的是 pending 里记下的 id，不是「最后一条」——同样是那个问题：
  // 期间若又追加了新消息，按位置撤会撤错一条。
  const cancelBreak = useCallback(() => {
    const pending = pendingRef.current
    pendingRef.current = null
    setState((s) => {
      const id = pending?.optimisticUserMessageId
      const idx = id ? s.messages.findIndex((m) => m.id === id) : -1
      const msgs = idx >= 0 ? s.messages.filter((_, i) => i !== idx) : s.messages
      return { ...s, pendingSegmentBreak: null, isStreaming: false, messages: msgs }
    })
  }, [])

  // P0-2：用户信任项目——落盘 trustedAt 后按原内容重发（不重复追加 user 消息）。
  const confirmTrust = useCallback(async () => {
    const pending = pendingTrustRef.current
    if (!pending) return
    pendingTrustRef.current = null
    try {
      await projectAPI.trust(pending.projectId)
    } catch (err) {
      // 信任失败（项目已删除等）：还原待办并提示，用户可重试或取消
      pendingTrustRef.current = pending
      setState((s) => ({
        ...s,
        pendingTrust: pending,
        error: `信任项目失败：${err instanceof Error ? err.message : String(err)}`,
      }))
      return
    }
    setState((s) => ({ ...s, isStreaming: true, error: null, pendingTrust: null }))
    await doStream(pending.text, {
      ...pending.opts,
      ...(pending.optimisticUserMessageId
        ? { optimisticUserMessageId: pending.optimisticUserMessageId }
        : {}),
    })
  }, [doStream])

  // P0-2：用户取消信任——清除待发并移除触发它的乐观 user 消息（同 cancelBreak，按 id 撤）。
  const cancelTrust = useCallback(() => {
    const pending = pendingTrustRef.current
    pendingTrustRef.current = null
    setState((s) => {
      const id = pending?.optimisticUserMessageId
      const idx = id ? s.messages.findIndex((m) => m.id === id) : -1
      const msgs = idx >= 0 ? s.messages.filter((_, i) => i !== idx) : s.messages
      return { ...s, pendingTrust: null, isStreaming: false, messages: msgs }
    })
  }, [])

  const abort = useCallback(() => {
    abortRef.current?.abort()
    // 通知后端终止 agent，而不只是中断前端 SSE 读取。
    // 若仅 abort 前端 fetch，后端依赖 stream.onAbort 检测断开，可能有延迟或遗漏。
    agentAPI.abort(sessionId).catch(() => {})
    setState((s) => ({ ...s, isStreaming: false }))
  }, [sessionId])

  /** 追加指令（steer）：注入运行中的 run，并乐观追加 user/steering 消息到时间线
   *  （与 sendMessage 乐观追加同生命周期：P0 前指令发出后从视图消失、刷新后彻底丢失）。
   *  后端同时持久化 steering 条目；页面重载后 /messages 返回该条目、chat.messages 已
   *  重置，单行展示。运行中若 history 重取，乐观副本与持久化条目并存与乐观 user
   *  消息属同一类既有行为，不新增风险。 */
  const steer = useCallback(
    (message: string) => {
      const text = message.trim()
      if (!text || !streamingRef.current) return
      agentAPI.steer(sessionId, text).catch(() => {
        // 后端失败不阻塞 UI；条目未持久化时该指令仅本轮内存生效
      })
      setState((s) => ({
        ...s,
        messages: [
          ...s.messages,
          {
            id: generateId(),
            sessionId,
            role: 'user',
            content: [{ _tag: 'steering', text }],
            tokenCount: 0,
            createdAt: Date.now(),
          },
        ],
      }))
    },
    [sessionId],
  )

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

  /** 超时后显式拒绝：resolve store 中的 pending 为 deny，run 继续执行。
   *  网络副作用在更新器之外（更新器必须是纯函数——StrictMode/并发渲染
   *  重放会重复执行，此前 confirmTool 写在更新器里同一拒绝请求发两次）。 */
  const denyTimedOutPermission = useCallback(() => {
    const timedOut = permissionTimeoutRef.current
    if (timedOut) {
      const { toolCallId } = timedOut
      void agentAPI.confirmTool(toolCallId, false).catch(() => {})
    }
    setState((s) => ({ ...s, permissionTimeout: null }))
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

  /** P1：附着轮询——每 2s 查状态，run 结束即刷新收尾。代数守卫防重复轮询。
   *  paused 不是结束：run 仍注册在服务端（可 resume），只是没有进展——继续轮询
   *  并映射为「暂停」态（runPaused + isStreaming），让「恢复」入口可见；从暂停
   *  恢复后下一 tick 看到 running 即清暂停态。此前 paused 落进 finishAttach 的
   *  结束分支：附着态清空、runPaused 从未置位——该标签页既无恢复入口，发送新
   *  消息又撞 409 RUN_ACTIVE（run 仍占用），会话锁死到手动刷新为止。 */
  const pollAttachedRun = useCallback(() => {
    stopPoll()
    const token = ++pollGenRef.current
    const tick = async () => {
      if (token !== pollGenRef.current) return
      try {
        const st = await sessionAPI.status(sessionId)
        if (token !== pollGenRef.current) return
        if (st?._tag === 'running' || st?._tag === 'paused') {
          const paused = st._tag === 'paused'
          setState((s) => ({
            ...s,
            isStreaming: true,
            // 暂停时改由暂停横幅（runPaused && isStreaming）承载状态与「恢复」，
            // 不再显示「运行中…中止」的附着横幅。
            attachedRun: !paused,
            runPaused: paused,
            runPauseReason: paused ? (st.pauseReason ?? null) : null,
          }))
          pollTimerRef.current = setTimeout(() => void tick(), paused ? 3000 : 2000)
        } else {
          finishAttach()
          // interrupted：run 已随服务重启消失（内存态丢失，resume 端点无效）——
          // 与 paused 同属「非普通结束」：普通收尾之外还要置中断态，让
          // 「上次对话被中断，重发上一条消息继续」入口可见（冷启动横幅只在
          // 挂载时判定一次，附着期间发生的中断否则对该页永远不可见）。
          if (st?._tag === 'interrupted') {
            setState((s) => ({ ...s, interrupted: true }))
          }
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
   *
   * 入口判定与 pollAttachedRun 同口径：paused 也是活跃 run（权限确认挂起/预算
   * 暂停，run 仍注册在服务端可 resume）——此前入口只认 running，冷启动挂载与
   * 跨标签页广播对已暂停的 run 直接放弃：runPaused 从未置位（该页无「恢复」
   * 入口）、挂起权限弹窗不重挂、run 结束广播也因 attachedRef 未置位被忽略；
   * 发新消息撞 409 RUN_ACTIVE，会话锁死到手动刷新为止。
   */
  const attach = useCallback(async () => {
    // attachingRef 同步占位：attach 内有 await，StrictMode/依赖变化下的重入
    // 若不拦截会并发多份查询与轮询。
    if (streamingRef.current || attachingRef.current) return
    attachingRef.current = true
    try {
      const st = await sessionAPI.status(sessionId).catch(() => null)
      if (st?._tag !== 'running' && st?._tag !== 'paused') return
      const paused = st._tag === 'paused'
      const pend = await sessionAPI.pendingPermission(sessionId).catch(() => null)
      attachedRef.current = true
      streamingRef.current = true
      setState((s) => ({
        ...s,
        isStreaming: true,
        attachedRun: !paused,
        runPaused: paused,
        runPauseReason: paused ? (st.pauseReason ?? null) : null,
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

  const clearRunPaused = useCallback(() => {
    setState((s) => ({ ...s, runPaused: false, runPauseReason: null }))
  }, [])

  const clearCompactionNotice = useCallback(() => {
    setState((s) => ({ ...s, compactionNotice: null }))
  }, [])

  const reset = useCallback(() => setState(INITIAL), [])

  return {
    ...state,
    /** 最近一次 sendMessage 失败的原因（成功/未失败时为 null）。跨页面传递用。 */
    lastFailureReason: failureReasonRef.current,
    sendMessage,
    abort,
    steer,
    confirm,
    confirmBreak,
    cancelBreak,
    confirmTrust,
    cancelTrust,
    retry,
    reopenPermission,
    denyTimedOutPermission,
    clearInterrupted,
    clearRunPaused,
    clearCompactionNotice,
    attach,
    reset,
  }
}
