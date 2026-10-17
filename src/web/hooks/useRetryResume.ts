// 中断恢复/出错重试：从 DB 重载消息定位「最后一条 assistant 回复之后」的
// 最后一条 user prompt 并完整重发（含图片），后端幂等跳过 append。
// 从 ChatSession 拆出——恢复/重试共用同一套 prompt 定位与重发编排。
import type { Message } from '@shared/types/message.js'
import type { QueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatActions, ChatState } from '@/hooks/chatState.js'
import { sessionAPI } from '@/services/session.js'

/** 失败原因取服务端 message（APIError）或 Error.message，与会话树/回收站失败提示同口径。 */
function messageOf(e: unknown): string {
  return (e as { message?: string } | null)?.message ?? (e instanceof Error ? e.message : String(e))
}

export function useRetryResume({
  sessionId,
  chat,
  qc,
  selection,
  agentName,
  onResumeStart,
}: {
  sessionId: string
  chat: ChatState & ChatActions
  qc: QueryClient
  selection: { provider: string; model: string }
  agentName: string
  /** handleResume 起点回调：清除冷启动中断标记等宿主状态。 */
  onResumeStart: () => void
}) {
  // 恢复中断的对话：从 DB 重载消息，定位「最后一条 assistant 回复之后」的
  // 最后一条 user 消息重发（后端幂等跳过 append）。
  // P0：steering 条目在 /messages 中以 user 角色返回但仅含 steering part——重发扫描
  // 需跳过它们，否则中断恰发生在追加指令后时 resume 静默失效。
  // P1-2：此前按「含 text part」向前找，纯图片消息（无 text）会被跳过，导致把
  // **更早的文本消息**重发给模型（旧指令重复执行）。现在定位最后一条 assistant
  // 之后、含任意内容（text 或 image）的 user 消息，图片经 images 参数一并重发。
  // 重发（重试/恢复）在途中：两者都先 await 两次网络往返（/messages、/sessions/:id）
  // 才调用 chat.retry 置流式态，这段窗口里按钮仍可点——双提交会起第二条 SSE 流
  // （服务端 409「该会话已有进行中的对话」，或工具重复执行）。ref 同步防重入，
  // state 供按钮禁用/文案（异步 setState 来不及挡住同一 tick 的第二次点击）。
  const resendRef = useRef(false)
  const [resendPending, setResendPending] = useState(false)

  // 重发失败原因：唯一的恢复入口（中断横幅）正是在 handleResume 起点被清掉的，
  // 请求失败时若不留原因，用户看到的是「点了恢复对话，什么都没发生」，
  // 而且横幅已经消失、无法再点一次（此前 reject 直接穿透成 unhandled rejection）。
  const [resendError, setResendError] = useState<string | null>(null)

  // 会话世代镜像：ChatSession 在会话间被路由复用（route.path 不变 → 子树不重建），
  // 本 hook 实例连同闭包里的 chat/qc/onResumeStart 跨会话存活。重发要先 await 两轮
  // 网络往返（/messages、/sessions/:id）才驱动共享 chat，这段窗口里用户切到 B 时
  // ChatSession 已对 B 执行过 chat.reset()（整块 setState({...INITIAL}) 抹掉 A 的
  // 流式态）——A 的续体若照常落地：onResumeStart/clearInterrupted/reset 会把 B 刚
  // 渲染好的状态再清一遍，setQueryData 会拿 A 的消息盖掉 B 的缓存，chat.retry 更会
  // 捕获新世代把 A 的重发流写进 B 的时间线。「在途的重发属于旧会话」只对不共享的
  // ref 成立，对共享 state 的每次写入都必须先比世代（与 useShake 的 sessionIdRef、
  // useChat 的 genRef 同口径）：不符即整体放弃。
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  // 会话级状态：ChatSession 在会话间被路由复用，useState 不会因 sessionId 变化重置。
  // 不重置的话，上一条会话「恢复对话失败：…」的红条会原样挂在下一条会话顶上——那条
  // 会话什么都没恢复过，用户以为它也失败了。在途的重发（resendRef/resendPending）不动：
  // 它属于旧会话，重置反而会放进第二次同会话重发（其在途期间对共享 chat/resendError
  // 的写入由上面的 sessionIdRef 世代校验拦下，这里只负责清已经画出来的红条）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId 只是复位的触发条件，不参与计算
  useEffect(() => {
    setResendError(null)
  }, [sessionId])

  const runResend = useCallback(async (label: string, run: () => Promise<void>) => {
    if (resendRef.current) return
    // 本次重发所属的会话：失败红条只准挂回发起它的会话。resendError 是跨会话共享
    // 的 state——请求/chat.retry 的失败落地时用户可能已经切走，无守卫的话旧会话的
    // 「恢复对话失败：…」会画到新会话顶上（sessionId 重置 effect 只清切换那一刻
    // 已存在的红条，管不住之后才落地的失败）。
    const sid = sessionIdRef.current
    resendRef.current = true
    setResendPending(true)
    setResendError(null)
    try {
      await run()
    } catch (e) {
      if (sessionIdRef.current === sid) setResendError(`${label}失败：${messageOf(e)}`)
    } finally {
      resendRef.current = false
      setResendPending(false)
    }
  }, [])

  const handleResume = () =>
    runResend('恢复对话', async () => {
      // 先从 DB 重载消息，**成功之后**才消费恢复入口（onResumeStart/clearInterrupted/reset）：
      // 会话已被删（404）、服务重启或断网时，重载这一步就失败。此前先清入口再发请求，
      // 失败后中断横幅连同「恢复对话」按钮一起消失，用户既看不到原因也无法重试，
      // 唯一的恢复路径被一次失败消费掉。
      const msgs = await sessionAPI.messages(sessionId)
      // 在途期间切了会话：重载结果属于旧会话，不得再驱动共享 chat（见 sessionIdRef）。
      if (sessionIdRef.current !== sessionId) return
      onResumeStart()
      chat.clearInterrupted()
      // 清空内存流式消息与运行态（中断标记/挂起弹窗）：随后从 DB 重载消息作为
      // 唯一事实源（乐观副本与服务端副本的合并去重已由 mergeSessionMessages 负责，
      // 此处清空是为了让中断前的半截内存态不参与 resume 判定）。
      chat.reset()
      qc.setQueryData(['session', sessionId, 'messages'], msgs)
      let lastAssistantIdx = -1
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.role === 'assistant') {
          lastAssistantIdx = i
          break
        }
      }
      const prompt = findLastPrompt(msgs, lastAssistantIdx)
      if (!prompt) {
        // 中断前没有任何可重发的 user 消息：横幅已被消费掉，若不说明，用户看到的是
        // 「点了恢复对话，对话停在原地」且再无入口可点。
        setResendError('恢复对话失败：中断前没有可重发的用户消息，无法自动续接。')
        return
      }
      await retryPrompt(prompt)
      if (sessionIdRef.current !== sessionId) return
      // M3：重发会触发服务端标记未完成轮次（写入 session.metadata）——
      // 刷新 meta 使时间线立即置灰半截内容。
      qc.invalidateQueries({ queryKey: ['session', sessionId, 'meta'] })
    })

  // 运行出错后的重试（P2-1）：与服务端错误（LLM 429/5xx 等）对等的中断恢复入口。
  // 复用同一套「定位最后一条 user prompt + 完整重发（含图片）」逻辑。
  const handleRetryLast = () =>
    runResend('重试', async () => {
      const msgs = await sessionAPI.messages(sessionId)
      if (sessionIdRef.current !== sessionId) return
      const prompt = findLastPrompt(msgs, -1)
      if (!prompt) {
        setResendError('重试失败：没有可重发的用户消息。')
        return
      }
      await retryPrompt(prompt)
    })

  /** 从重载消息中定位待重发的 user prompt（跳过仅含 steering 的空条目）。 */
  const findLastPrompt = (
    msgs: Message[],
    afterIdx: number,
  ): { text: string; images: Array<{ mediaType: string; data: string }> } | null => {
    for (let i = msgs.length - 1; i > afterIdx; i--) {
      const m = msgs[i]
      if (m?.role !== 'user') continue
      const images = m.content
        .filter((p): p is { _tag: 'image'; mediaType: string; data: string } => p._tag === 'image')
        .map((p) => ({ mediaType: p.mediaType, data: p.data }))
      const text = m.content
        .filter((p): p is { _tag: 'text'; text: string } => p._tag === 'text')
        .map((p) => p.text)
        .join('')
      if (text.length === 0 && images.length === 0) continue // steering-only 条目
      return { text, images }
    }
    return null
  }

  /** 按原 run 的 provider/model/agent（缺省回退当前选择）重发 prompt。 */
  const retryPrompt = async (prompt: {
    text: string
    images: Array<{ mediaType: string; data: string }>
  }) => {
    const session = await sessionAPI.get(sessionId)
    // get 在途期间切了会话：chat.retry 走 doStream 时会捕获新世代，把 A 的重发流
    // 写进 B 的时间线（见 sessionIdRef）。
    if (sessionIdRef.current !== sessionId) return
    const lr = session.metadata.lastRun
    await chat.retry(prompt.text, {
      ...(lr?.provider ? { provider: lr.provider } : { provider: selection.provider }),
      ...(lr?.model ? { model: lr.model } : { model: selection.model }),
      ...(lr?.agentName ? { agent: lr.agentName } : { agent: agentName }),
      ...(prompt.images.length > 0 ? { images: prompt.images } : {}),
    })
  }

  return {
    handleResume,
    handleRetryLast,
    resendPending,
    resendError,
    clearResendError: () => setResendError(null),
  }
}
