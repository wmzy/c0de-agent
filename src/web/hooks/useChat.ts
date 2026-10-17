import type { Message, MessageContent } from '@shared/types/message.js'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  broadcastRunState,
  type ChatActions,
  type ChatOpts,
  type ChatState,
  INITIAL,
  type LastFailure,
  type PendingPermission,
  type PendingSegmentBreak,
  type PendingTrust,
  RUN_CHANNEL,
  type RunStateMessage,
  reduceChatEvent,
  sealInFlightTools,
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

/** 服务端压缩「未受理」的 reason → 用户可读文案（见 core/session/compaction.ts）。
 *  200 不代表受理：消息过少 / 无内容可压缩时服务端回 {compacted:false, reason}。 */
const COMPACTION_SKIP_REASON: Record<string, string> = {
  too_few_messages: '消息太少，无需压缩',
  nothing_to_compact: '没有可压缩的内容',
}

/** 附着入口读 GET /:id/status 失败时的自愈重试：3s 一次、最多 3 次，
 *  之后才把原因摆到界面上（见 attach 的说明）。 */
const ATTACH_MAX_ATTEMPTS = 3
const ATTACH_RETRY_DELAY = 3000

export function useChat(sessionId: string): ChatState & ChatActions {
  const [state, setState] = useState<ChatState>(INITIAL)
  const abortRef = useRef<AbortController | null>(null)
  /**
   * 会话世代号：切换会话时递增，在飞的流据此判定自己已过期。
   *
   * 切换会话不 abort fetch——服务端把 SSE 断开当作「用户终止」
   * （src/server/routes/chat.ts 的 stream.onAbort → agentManager.abort），
   * abort 会连带杀掉后台 run，与「离开页面后 run 继续跑、回来用 attach 重挂」
   * 的设计冲突。所以旧流继续读，但它的 onEvent/setState 结果必须被丢弃：
   * 否则旧会话的 text_delta/tool_call 会写进刚复位成 INITIAL 的 state，
   * 经 mergeSessionMessages 渲染成**新会话时间线里上一条会话的回复**。
   */
  const genRef = useRef(0)
  // P1 后台附着：流式/权限超时态镜像——副作用（confirmTool 网络请求）必须
  // 在状态更新器之外发起：更新器是纯函数，StrictMode/并发渲染重放会重复
  // 执行，写进更新器会让同一拒绝请求发出两次。
  const permissionTimeoutRef = useRef<ChatState['permissionTimeout']>(null)
  permissionTimeoutRef.current = state.permissionTimeout
  // 超时横幅「拒绝并继续」的在途锁（同步 ref，渲染路径不可见）：双击的第二击在
  // denyTimedOutPermission 入口直接 no-op——时序与理由见该函数内的注释。
  const denyPendingRef = useRef(false)
  // P1 后台附着：流式/附着态镜像 + 轮询代数与定时器。
  const streamingRef = useRef(false)
  const attachedRef = useRef(false)
  const attachingRef = useRef(false)
  const pollGenRef = useRef(0)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * P1 附着入口的自愈重试（读 GET /:id/status 失败时）。
   *
   * attach 是「本页没发起流、但服务端确实有 run」的唯一入口，此前它把读失败
   * `.catch(() => null)` 折叠成「没有 run」：一次 500 / 网络抖动就与真的空闲走同一条
   * return，页面渲染成一个没有任何运行痕迹的会话，而服务端 run 仍在跑工具、改文件。
   * 用户在这个假空闲态下发消息 → 409 RUN_ACTIVE「该会话已有进行中的对话」——一句与
   * 事实相反、且没有任何出口的结论（没有终止键、没有恢复入口、attach 不会重试）。
   * 与 pollAttachedRun 的读失败同款：先自愈重试，连续失败才把原因摆到界面上。
   */
  const attachGenRef = useRef(0)
  const attachAttemptRef = useRef(0)
  const attachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // attach 的自引用（重试要再调自己）：直接闭包引用自身在 TS 里是块级作用域前向引用，
  // 走 ref 最省事，也顺带保证重试拿到的是最新一次渲染的闭包。
  const attachRef = useRef<() => Promise<void>>(async () => {})
  // 本页已给出决定（确认/拒绝）的权限请求 id：confirm 乐观清空弹窗后，服务端
  // store 的消费有网络延迟，附着轮询的下一次复查会看到「仍在挂起」而把弹窗又弹
  // 回来（用户以为按钮没生效）。同一 toolCallId 只消费一次，记下即可。
  const decidedPermissionRef = useRef<Set<string>>(new Set())
  // 段切换确认待发内容（confirmBreak/cancelBreak 读取，避免闭包staleness）
  const pendingRef = useRef<PendingSegmentBreak | null>(null)
  // P0-2：信任确认待发内容（confirmTrust/cancelTrust 读取）
  const pendingTrustRef = useRef<PendingTrust | null>(null)
  // 最近一次由 steer 写进 error 的原因：后续 steer 成功时据此精确撤回自己那条，
  // 不误伤工具失败等其它来源的错误。
  const steerFailureRef = useRef<string | null>(null)
  const llmDetailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * 最近一次 sendMessage 的结果：失败原因 + 是否需要用户决策。
   *
   * 以 **ref** 暴露给调用方（而不是普通字段）：chat 对象是每次渲染新建的快照，
   * 调用方在自己的 .then 里读字段只能拿到发送**前**那一帧——失败路径的 setState
   * 尚未重渲染，字段恒为旧值。跨页面把原因带走（首条失败后清空会话回草稿页）
   * 与「这次失败是等待用户决策（信任/段边界）还是真的白费」都依赖这里的实时值。
   */
  const lastFailureRef = useRef<LastFailure>({ reason: null, gate: null })
  const qc = useQueryClient()

  /** 停止附着轮询（幂等：递增代数使在途 tick 失效）。 */
  const stopPoll = useCallback(() => {
    pollGenRef.current += 1
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  /** 停止附着入口的重试链（幂等：递增代数使在途定时器失效）。 */
  const stopAttachRetry = useCallback(() => {
    attachGenRef.current += 1
    attachAttemptRef.current = 0
    if (attachTimerRef.current) {
      clearTimeout(attachTimerRef.current)
      attachTimerRef.current = null
    }
  }, [])

  // 切换会话时重置本地流式状态；历史消息由调用方合并加载
  // P1：同时停止附着轮询并复位镜像 ref——挂起/附着态随会话切换整体作废。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅依赖 sessionId 触发重置
  useEffect(() => {
    // 先作废旧世代：在飞的流从此不再写 state（详见 genRef 注释）。
    genRef.current += 1
    stopPoll()
    stopAttachRetry()
    streamingRef.current = false
    attachedRef.current = false
    attachingRef.current = false
    setState(INITIAL)
  }, [sessionId])

  // 卸载时停止附着轮询与重试链：tick 链每轮自行续期，不清理的话组件卸载后仍会
  // 持续请求 /status（暂停态下 run 可长期挂着，链无自然终止点）。
  useEffect(() => {
    return () => {
      stopPoll()
      stopAttachRetry()
    }
  }, [stopPoll, stopAttachRetry])

  // 执行 SSE 流并归约事件；捕获 409 SEGMENT_BREAK_REQUIRED 时存入 pendingSegmentBreak。
  // SSE 流未收到 done 事件结束时标记 interrupted（服务重启等）；
  // 但若已收到 error 事件，说明是服务端正常错误（LLM 报错等），不标记中断。
  // 返回 ok=false 表示本轮未正常完成（供调用方做首条消息失败清理等）。
  const doStream = useCallback(
    async (content: string, opts: ChatOpts | undefined): Promise<boolean> => {
      // 本轮所属世代：期间切换会话（genRef 递增）后，本轮的 state 写入一律作废。
      const gen = genRef.current
      const isStale = () => genRef.current !== gen
      abortRef.current = new AbortController()
      // P1：标记流式态并广播 run 启动——同会话其他标签页据此附着显示运行态。
      streamingRef.current = true
      // 新一轮开始：清掉上轮的失败原因
      lastFailureRef.current = { reason: null, gate: null }
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
            // 切换会话后本轮的归约一律丢弃（缓存失效仍照做：那是给旧会话用的，
            // 回到它会重取）。否则旧会话的正文/工具卡会渲染进新会话的时间线。
            if (!isStale()) setState((s) => reduceChatEvent(s, event))
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
        if (isStale()) return false
        if (!result.done && !gotError) {
          // SSE 结束但未收到 done 也无 error → 连接中断（服务重启等）
          lastFailureRef.current = { reason: INTERRUPTED_REASON, gate: null }
          setState((s) => ({
            ...s,
            isStreaming: false,
            interrupted: true,
            messages: sealInFlightTools(s.messages),
          }))
        } else if (!result.done && gotError) {
          // 服务端正常错误（LLM 报错等），设 isStreaming=false 但不标记中断。
          // 在途工具同样不会再收到结果：必须封口，否则卡片永远停在 ⏳ 执行中。
          setState((s) => ({
            ...s,
            isStreaming: false,
            messages: sealInFlightTools(s.messages),
          }))
        }
        return result.done
      } catch (err) {
        const e = err as unknown as APIError
        // 本轮已随会话切换作废：一条状态都不写——包括待发弹窗（pendingTrust/
        // pendingSegmentBreak）与乐观消息撤回：后者作用在**新会话**的 state 上
        // 会删错消息。返回 false 让调用方照旧把草稿还给用户（发送未必送达）。
        if (isStale()) return false
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
          // ref 必须在 setState 之外同步写：更新器函数延迟到重渲染才执行，而
          // cleanupEmptySessionOnFailure 在 sendMessage 的 .then 微任务里读它，
          // 写晚了草稿页横幅就退化为兜底文案（与相邻分支的写法一致）。
          lastFailureRef.current = { reason: '该会话已有进行中的对话', gate: null }
          setState((s) => {
            const msgs = withdraw(s.messages)
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
          lastFailureRef.current = { reason: e.message, gate: null }
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
          // 同上：ref 写在 setState 之外（更新器延迟执行，读点不保证在其后）。
          lastFailureRef.current = { reason: e.message, gate: null }
          setState((s) => {
            const msgs = withdraw(s.messages)
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
          // 标记为「等待用户决策」：本次发送不是白费，调用方不得据此清会话
          // （弹窗渲染在本组件里，清会话 + 导航会把弹窗连同原因一起卸载）。
          lastFailureRef.current = { reason: e.message, gate: 'trust' }
          setState((s) => ({
            ...s,
            isStreaming: false,
            pendingTrust: pending,
            trustPending: false,
            trustError: null,
          }))
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
          // 同 TRUST_REQUIRED：等待用户确认开新段，不是发送白费。
          lastFailureRef.current = { reason: e.message, gate: 'segmentBreak' }
          setState((s) => ({ ...s, isStreaming: false, pendingSegmentBreak: pending }))
          return false
        }
        if (abortRef.current.signal.aborted) {
          if (llmDetailTimerRef.current) {
            clearTimeout(llmDetailTimerRef.current)
            llmDetailTimerRef.current = null
          }
          qc.invalidateQueries({ queryKey: ['session', sessionId, 'llm-details'] })
          // 用户按「终止」：服务端会落 aborted 的工具结果（下次重取即覆盖），但本地
          // SSE 已被掐断、那份结果送不到——不封口的话工具卡停在 ⏳，而「终止」按钮
          // 已经消失，界面自己说运行停了、又在同一块卡上说「执行中」。
          setState((s) => ({
            ...s,
            isStreaming: false,
            messages: sealInFlightTools(s.messages),
          }))
        } else if (typeof e.status === 'number') {
          // 服务端 HTTP 错误（带 status）：后端已经给出可操作文案，这不是「连接中断」。
          // 上面各 code 分支只覆盖 8 种已知错误，其余——404 会话不存在或已删除、
          // 409 RUN_STARTING、400 INVALID_AGENT / 图片校验失败、401 认证失效、
          // 500 CWD_RESOLVE_FAILED——此前全部落入「网络错误视为中断」：顶栏错误位
          // 空白，横幅谎报「服务可能已重启」，乐观 user 消息留在时间线上，而
          // 「恢复对话」只是重发同一请求、必然再次失败，用户被困在错误的诊断里。
          // 与各 code 分支同口径：撤回乐观消息 + 透出后端文案（含重试入口）。
          const reason = e.message || `请求失败（HTTP ${e.status}）`
          lastFailureRef.current = { reason, gate: null }
          setState((s) => {
            const msgs = sealInFlightTools(withdraw(s.messages))
            return {
              ...s,
              messages: msgs,
              isStreaming: false,
              error: reason,
            }
          })
        } else {
          // 无 status：fetch 本身失败（服务不可达）或请求在途被打断 → 视为中断
          lastFailureRef.current = { reason: INTERRUPTED_REASON, gate: null }
          setState((s) => ({
            ...s,
            isStreaming: false,
            interrupted: true,
            messages: sealInFlightTools(s.messages),
          }))
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
      // 本次确认所属世代：压缩可走 LLM 摘要、窗口以秒计，请求飞在路上时用户切到
      // B（genRef 递增）后，迟到的 compactError/isStreaming 会写进 B 的状态，随后
      // 的 doStream 又在调用时才捕获 genRef.current（新世代）、isStale() 恒 false
      // ——A 的重发 SSE 会整段归约进 B 的时间线。与 steer/abort 同款：入口记世代，
      // 每个 await 之后、写 state/doStream 之前比对，不一致即弃（B 的状态由切会话
      // 时的 INITIAL 重置与它自己的请求决定）。
      const gen = genRef.current
      // 用户显式选择了「顺便压缩会话」：这条路必须兑现或明确说没兑现。
      // 此前 compact 的返回值被丢弃、catch 只 console.error——压缩没发生也照常重发，
      // 旧上下文没被摘要、新段按未压缩上下文计费，且同一段边界会再次弹层，用户只
      // 以为「压缩了但还是不行」而反复点（观感与「仅开新段」完全一致）。
      let compactError: string | null = null
      if (withCompaction) {
        try {
          const result = await sessionAPI.compact(sessionId)
          if (genRef.current !== gen) return
          if (!result.compacted) {
            const why = result.reason
              ? (COMPACTION_SKIP_REASON[result.reason] ?? result.reason)
              : '当前上下文无需压缩'
            compactError = `会话未压缩：${why}，已按未压缩内容继续开新段`
          }
        } catch (err) {
          if (genRef.current !== gen) return
          compactError = `会话压缩失败：${
            err instanceof Error ? err.message : String(err)
          }，已按未压缩内容继续开新段`
        }
      }
      // 压缩结论在重发之前落地：error:null 只用于清掉段确认弹层遗留，不能顺手
      // 抹掉刚拿到的压缩失败原因（成功时仍清空，与原行为一致）。
      setState((s) => ({ ...s, isStreaming: true, error: compactError, pendingSegmentBreak: null }))
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
    // 本次确认所属世代：trust 请求飞在路上时用户切到 B（genRef 递增）后，迟到的
    // 写入全部属于 A——失败分支把 A 的信任弹窗（pendingTrust/trustError/error）
    // 原样弹在 B 上；成功分支随后的 doStream 又在调用时才捕获 genRef.current（新
    // 世代）、isStale() 恒 false，A 的重发 SSE 会整段归约进 B 的时间线。与
    // steer/abort 同款：入口记世代，每个 await 之后、写 state/doStream 之前比对，
    // 不一致即弃。
    const gen = genRef.current
    // 在飞期间弹窗内禁用按钮并禁止关闭：否则连点会重复发 trust 请求，或用户按 Esc
    // 把弹窗连同失败原因一起卸载。
    setState((s) => ({ ...s, trustPending: true, trustError: null }))
    try {
      await projectAPI.trust(pending.projectId)
    } catch (err) {
      if (genRef.current !== gen) return
      // 信任失败（项目已删除等）：还原待办并提示，用户可重试或取消。
      // 原因写进 trustError（渲染在弹窗内部），同时保留 error 供会话区横幅兜底。
      const message = `信任项目失败：${err instanceof Error ? err.message : String(err)}`
      pendingTrustRef.current = pending
      setState((s) => ({
        ...s,
        pendingTrust: pending,
        trustPending: false,
        trustError: message,
        error: message,
      }))
      return
    }
    if (genRef.current !== gen) return
    setState((s) => ({
      ...s,
      isStreaming: true,
      error: null,
      trustPending: false,
      trustError: null,
      pendingTrust: null,
    }))
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
      return {
        ...s,
        pendingTrust: null,
        trustPending: false,
        trustError: null,
        isStreaming: false,
        messages: msgs,
      }
    })
  }, [])

  const abort = useCallback(() => {
    abortRef.current?.abort()
    // 通知后端终止 agent，而不只是中断前端 SSE 读取。
    // 若仅 abort 前端 fetch，后端依赖 stream.onAbort 检测断开，可能有延迟或遗漏。
    //
    // 200 不等于停下来了：aborted:false 表示后端没有可终止的 run；而请求本身失败
    // （500 / 断网）时后端 agent 照样在跑、继续改文件烧 token。两者此前都被空吞，
    // 界面却已翻成 isStreaming:false——用户看到「已停止」而 agent 无人看管地继续。
    // 失败写 abortError（横幅带「重新终止」），与 error 分开：终止失败后
    // isStreaming 已是 false，挂在 error 上会连带亮出「重试最后一条消息」。
    setState((s) => ({ ...s, isStreaming: false, abortError: null }))
    // 本次终止所属世代：请求飞在路上时用户切走会话（genRef 递增）后，响应里的
    // abortError 属于**上一条**会话——写进新会话会在 B 页面上凭空挂一条
    // 「终止没有送达」红条（连带「重新终止」按钮），而 A 的真实结果永久丢失。
    // 请求本身仍用发起时的 sessionId，切回 A 时结果由 A 自己的 /status 反映。
    const gen = genRef.current
    void agentAPI
      .abort(sessionId)
      .then((res) => {
        if (genRef.current !== gen) return
        if (res.aborted) return
        setState((s) => ({
          ...s,
          abortError:
            '终止没有送达：后端没有进行中的运行（可能已在其他标签页结束）。若界面仍显示运行中，请刷新确认。',
        }))
      })
      .catch((err) => {
        if (genRef.current !== gen) return
        setState((s) => ({
          ...s,
          abortError: `终止请求失败：${err instanceof Error ? err.message : String(err)}。agent 可能仍在后台继续执行工具，请刷新确认后再继续。`,
        }))
      })
  }, [sessionId])

  /** 追加指令（steer）：注入运行中的 run，并乐观追加 user/steering 消息到时间线
   *  （与 sendMessage 乐观追加同生命周期：P0 前指令发出后从视图消失、刷新后彻底丢失）。
   *  后端同时持久化 steering 条目；页面重载后 /messages 返回该条目、chat.messages 已
   *  重置，单行展示。运行中若 history 重取，乐观副本与持久化条目并存与乐观 user
   *  消息属同一类既有行为，不新增风险。
   *
   *  返回 Promise<boolean>：这条指令是否真的被受理。POST /api/chat/steer 的 200
   *  不等于受理——没有进行中的 run 时它回 {steered:false}，指令既没注入 run 也没
   *  落库。此前这里从不读响应体、失败只 console，两种结局都糟：有乐观气泡
   *  （刷新即消失、agent 从未收到），或调用方已清空输入框而屏幕上什么都没发生。
   *  现在 false 时不追加乐观条目，并把原因摊给 error（Chat 的 errorBanner 以
   *  role=alert 渲染独占一行），调用方据此保留输入。
   */
  const steer = useCallback(
    async (message: string): Promise<boolean> => {
      const text = message.trim()
      if (!text) return false
      // 本次指令所属世代：steer 此前是 useChat 里唯一没有世代守卫的写 state 路径
      // （doStream / abort / confirm / denyTimedOutPermission 都有）。请求飞在路上时
      // 用户切到 B ⇒ 迟到的乐观条目与失败原因都写进 B 的时间线：B 凭空多出一条
      // 属于 A 的「用户刚刚说的指令」（sessionId 还是 A 的），失败时 B 顶上挂一条
      // 与 B 无关的红条，而 A 的真实结果无人知晓。返回 false：不受理（composer 的
      // clear 另有 scopeGenRef 把关，不会误清 B 的输入框）。
      const gen = genRef.current
      const failSteer = (reason: string) => {
        if (genRef.current !== gen) return
        steerFailureRef.current = reason
        setState((s) => ({ ...s, error: reason }))
      }
      if (!streamingRef.current) {
        failSteer(
          '追加指令未送达：本次对话已结束，没有可注入的运行。请直接发送为新消息（输入已保留）。',
        )
        return false
      }
      let steered = false
      try {
        const res = await agentAPI.steer(sessionId, text)
        steered = res.steered
      } catch (err) {
        failSteer(`追加指令发送失败：${err instanceof Error ? err.message : String(err)}`)
        return false
      }
      if (!steered) {
        failSteer(
          '追加指令未送达：后端没有进行中的运行（可能已在另一个标签页结束），输入已保留，请直接发送。',
        )
        return false
      }
      if (genRef.current !== gen) return false
      setState((s) => {
        const next = {
          ...s,
          messages: [
            ...s.messages,
            {
              id: generateId(),
              sessionId,
              role: 'user' as const,
              content: [{ _tag: 'steering' as const, text }],
              tokenCount: 0,
              createdAt: Date.now(),
            },
          ],
        }
        // 只撤自己写的那一条：error 是单一字段，工具失败等其它来源的原因不该被
        // 一次成功的追加指令顺手抹掉。
        if (steerFailureRef.current && s.error === steerFailureRef.current) {
          steerFailureRef.current = null
          next.error = null
        }
        return next
      })
      return true
    },
    [sessionId],
  )

  // 权限确认：乐观清空 pending，弹窗立即关闭。后端 store 的 pending 一次消费即删除，
  // 若不清空前端状态，弹窗会一直显示到 done 事件，期间用户重复点击会对已消费的
  // toolCallId 触发 404（"No pending permission"）。
  // alwaysAllowTool：用户勾选「本会话始终允许」时，先追加会话白名单再确认。
  const confirm = useCallback(
    (
      toolCallId: string,
      approved: boolean,
      alwaysAllowTool?: string,
      // 调用方在清空 pending 前把它交进来：确认请求失败时要把弹窗原样还回去。
      pending?: PendingPermission,
    ) => {
      setState((s) => ({ ...s, pendingPermission: null }))
      // 记下这次决定：附着轮询复查 /pending 时 store 可能还没删掉它（消费在路上），
      // 否则弹窗会被重新弹回来。
      decidedPermissionRef.current.add(toolCallId)
      // 本次决定所属世代：确认请求飞在路上时切走会话后，失败原因/弹窗还原都属于
      // 上一条会话——写进新会话会凭空挂一条「权限确认没有送达」，甚至把上一条
      // 会话的待确认弹窗弹在 B 上。
      const gen = genRef.current
      const doConfirm = () =>
        agentAPI.confirmTool(toolCallId, approved).catch((err) => {
          if (genRef.current !== gen) return
          const e = err as { status?: number }
          if (e?.status === 404) {
            // 已被处理（其他标签页确认/拒绝）或 run 已中止：明确提示，避免「以为已批准」。
            // P3 文案修正：此前写「超过 5 分钟未确认」，但 P2-9 后交互式权限不再超时自动拒绝。
            setState((s) => ({
              ...s,
              error: '权限请求已被处理（可能在其他标签页确认/拒绝）或已中止，工具未执行',
            }))
          } else {
            // 请求没送达（500 / 网络中断），服务端 pending 仍在、工具还在等决定。
            // 此前只有 console.error：弹窗已乐观关闭，用户以为「拒绝了」或
            // 「已批准」，实际 run 卡在等待权限上，界面零反馈。把弹窗还回去并
            // 说明原因，用户可以再决定一次（与 reopenPermission 同一口径）。
            setState((s) => ({
              ...s,
              error: '权限确认没有送达，工具仍在等待你的决定。请重新确认。',
              ...(pending ? { pendingPermission: pending } : {}),
            }))
          }
        })
      if (approved && alwaysAllowTool) {
        permissionAPI
          .setAlwaysAllow(alwaysAllowTool, sessionId)
          .catch((err) => {
            if (genRef.current !== gen) return
            // 白名单写入失败此前只 console.error：用户勾了「本会话始终允许」并点
            // 「允许」，看到的是一次完全成功的授权，但白名单根本没写进去——
            // 同一工具下次还会弹确认，白名单 chips 栏里也不会有它，用户只会以为
            // 「勾选没生效」，于是每次重新勾选。工具本身仍按用户的选择执行（批准
            // 与否与白名单是两个独立决定），但失败原因必须说出来。
            const reason = err instanceof Error ? err.message : String(err)
            setState((s) => ({
              ...s,
              error: `「本会话始终允许 ${alwaysAllowTool}」未保存：${reason}（该工具本次仍按你的选择执行，下次会再次询问）`,
            }))
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
   *  重放会重复执行，此前 confirmTool 写在更新器里同一拒绝请求发两次）。
   *
   *  此前请求失败被 .catch(() => {}) 空吞、超时态无条件清空：500 / 网络中断时
   *  拒绝根本没送达，服务端 pending 仍在（store 的 5 分钟提示 + 25 分钟宽限双层
   *  超时），run 继续等这个决定，而页面上唯一能再次进入该决策的入口——超时横幅
   *  的「重新询问 / 拒绝并继续」——已经消失，用户零反馈、以为工具已被拒绝。
   *  与 confirm() 同口径读响应结果：只有确认送达才收起横幅。 */
  const denyTimedOutPermission = useCallback(() => {
    // 在途防重入（与 composer 的 steerPendingRef 同款同步 ref）：按钮没有暴露
    // pending 给渲染（也就没有 disabled），双击的第二击到达时第一击的拒绝还在飞、
    // permissionTimeout 尚未被清空——若照常发请求，服务端 pending 已被第一击消费
    // → 404 → 走「已被处理/已中止」分支写出与事实相悖的 error 横幅（实际拒绝已
    // 送达、run 正常继续）。第二击 no-op，第一击的结论落地后横幅自然收起/保留。
    if (denyPendingRef.current) return
    const timedOut = permissionTimeoutRef.current
    if (!timedOut) {
      // 没有待处理的超时态（重复点击等）：无请求要发，直接清空。
      setState((s) => ({ ...s, permissionTimeout: null }))
      return
    }
    const { toolCallId } = timedOut
    // 本次拒绝所属世代：请求在途时切走会话后，成功「收起横幅」或失败原因都不该
    // 落到新会话上（新会话超时态由它自己的 /status 决定）。
    const gen = genRef.current
    denyPendingRef.current = true
    void agentAPI
      .confirmTool(toolCallId, false)
      .then(
        () => {
          if (genRef.current !== gen) return
          setState((s) => ({ ...s, permissionTimeout: null }))
        },
        (err) => {
          if (genRef.current !== gen) return
          const e = err as { status?: number }
          if (e?.status === 404) {
            // 已被处理（其他标签页确认/拒绝）或 run 已中止：工具不会执行，超时态可清。
            setState((s) => ({
              ...s,
              permissionTimeout: null,
              error: '权限请求已被处理（可能在其他标签页确认/拒绝）或已中止，工具未执行',
            }))
          } else {
            // 拒绝没送达：服务端 pending 仍在、工具还在等你的决定。保留超时态，
            // 横幅的两个入口继续可用，用户可以再拒绝一次。
            setState((s) => ({
              ...s,
              error: '权限拒绝没有送达，工具仍在等待你的决定。请重试。',
            }))
          }
        },
      )
      // 在途锁随请求结论归位：失败（非 404）时横幅保留、用户要能再拒一次；切会话
      // （世代不符提前 return）也照样归位，不把锁死留给下一条会话。
      .finally(() => {
        denyPendingRef.current = false
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
      // run 已结束＝状态重新是确定的：附着入口那次读失败的原因随之失效。
      attachError: null,
      pendingPermission: null,
      permissionTimeout: null,
    }))
    qc.invalidateQueries({ queryKey: ['session', sessionId, 'messages'] })
    qc.invalidateQueries({ queryKey: ['session', sessionId, 'llm-details'] })
  }, [qc, sessionId, stopPoll])

  /** 附着态同步挂起权限：以服务端 store 为准。附着页没有本次 run 的 SSE 流
   *  （permission_required 只在发起流的标签页送得到），权限请求只能从
   *  GET /:id/pending 读到——附着期新出现的请求因此必须靠轮询复查才能看见。
   *  pending 为空即收起弹窗：本页/他页已给出决定，或服务端宽限超时自动拒绝，
   *  否则用户对着一个已失效的请求点确认只会拿到 404。 */
  const syncPendingPermission = useCallback((pending: PendingPermission | null) => {
    setState((s) => {
      if (pending) {
        if (s.pendingPermission?.toolCallId === pending.toolCallId) return s
        if (decidedPermissionRef.current.has(pending.toolCallId)) return s
        return { ...s, pendingPermission: pending }
      }
      return s.pendingPermission ? { ...s, pendingPermission: null } : s
    })
  }, [])

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
          // 附着期新出现的权限请求：本页没有 run 的 SSE 流，只能在这里复查
          // （读内存 store，不触 DB）。失败静默——下一次 tick 会重试。
          const pend = await sessionAPI.pendingPermission(sessionId).catch(() => null)
          if (token !== pollGenRef.current) return
          if (pend) syncPendingPermission(pend.pending ?? null)
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
  }, [finishAttach, sessionId, stopPoll, syncPendingPermission])

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
    const gen = attachGenRef.current
    try {
      let st: Awaited<ReturnType<typeof sessionAPI.status>>
      try {
        st = await sessionAPI.status(sessionId)
      } catch (err) {
        if (gen !== attachGenRef.current) return
        // 读失败 ≠ 没有活跃 run（见 attachAttemptRef 的说明）：先自愈重试，与
        // pollAttachedRun 的读失败同款；连续失败才摆出原因，让用户知道此刻
        // 「不知道有没有 run」而不是「没有 run」。
        if (attachAttemptRef.current < ATTACH_MAX_ATTEMPTS) {
          attachAttemptRef.current += 1
          attachTimerRef.current = setTimeout(() => {
            if (gen !== attachGenRef.current) return
            void attachRef.current()
          }, ATTACH_RETRY_DELAY)
          return
        }
        setState((s) => ({
          ...s,
          attachError:
            (err as { message?: string } | null)?.message ??
            (err instanceof Error ? err.message : '状态检查失败'),
        }))
        return
      }
      if (gen !== attachGenRef.current) return
      if (st?._tag !== 'running' && st?._tag !== 'paused') {
        // 读到了「确实没有活跃 run」：这是确定的结论，任何旧的读失败原因都可以撤。
        setState((s) => (s.attachError ? { ...s, attachError: null } : s))
        return
      }
      const paused = st._tag === 'paused'
      const pend = await sessionAPI.pendingPermission(sessionId).catch(() => null)
      if (gen !== attachGenRef.current) return
      attachAttemptRef.current = 0
      attachedRef.current = true
      streamingRef.current = true
      setState((s) => ({
        ...s,
        isStreaming: true,
        attachedRun: !paused,
        runPaused: paused,
        runPauseReason: paused ? (st.pauseReason ?? null) : null,
        error: null,
        attachError: null,
        ...(pend?.pending ? { pendingPermission: pend.pending, permissionTimeout: null } : {}),
      }))
      pollAttachedRun()
    } finally {
      attachingRef.current = false
    }
  }, [pollAttachedRun, sessionId])
  attachRef.current = attach

  /** P1：读失败后的「重新检查」——复位重试计数，让这次点击也能享受自愈重试。 */
  const retryAttach = useCallback(() => {
    attachAttemptRef.current = 0
    if (attachTimerRef.current) {
      clearTimeout(attachTimerRef.current)
      attachTimerRef.current = null
    }
    void attach()
  }, [attach])

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
    lastFailure: lastFailureRef,
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
    retryAttach,
    reset,
  }
}
