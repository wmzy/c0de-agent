// 中断恢复/出错重试：从 DB 重载消息定位「最后一条 assistant 回复之后」的
// 最后一条 user prompt 并完整重发（含图片），后端幂等跳过 append。
// 从 ChatSession 拆出——恢复/重试共用同一套 prompt 定位与重发编排。
import type { Message } from '@shared/types/message.js'
import type { QueryClient } from '@tanstack/react-query'
import type { ChatActions, ChatState } from '@/hooks/chatState.js'
import { sessionAPI } from '@/services/session.js'

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
  const handleResume = async () => {
    onResumeStart()
    chat.clearInterrupted()
    // 清空内存流式消息：中断前的乐观副本（user 消息/steering）与即将重载的
    // DB 消息合并会重复渲染（同一类既有缺陷随 steering 持久化显性化）。
    chat.reset()
    const msgs = await sessionAPI.messages(sessionId)
    qc.setQueryData(['session', sessionId, 'messages'], msgs)
    let lastAssistantIdx = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === 'assistant') {
        lastAssistantIdx = i
        break
      }
    }
    const prompt = findLastPrompt(msgs, lastAssistantIdx)
    if (prompt) {
      await retryPrompt(prompt)
      // M3：重发会触发服务端标记未完成轮次（写入 session.metadata）——
      // 刷新 meta 使时间线立即置灰半截内容。
      qc.invalidateQueries({ queryKey: ['session', sessionId, 'meta'] })
    }
  }

  // 运行出错后的重试（P2-1）：与服务端错误（LLM 429/5xx 等）对等的中断恢复入口。
  // 复用同一套「定位最后一条 user prompt + 完整重发（含图片）」逻辑。
  const handleRetryLast = async () => {
    const msgs = await sessionAPI.messages(sessionId)
    const prompt = findLastPrompt(msgs, -1)
    if (prompt) await retryPrompt(prompt)
  }

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
    const lr = session.metadata.lastRun
    await chat.retry(prompt.text, {
      ...(lr?.provider ? { provider: lr.provider } : { provider: selection.provider }),
      ...(lr?.model ? { model: lr.model } : { model: selection.model }),
      ...(lr?.agentName ? { agent: lr.agentName } : { agent: agentName }),
      ...(prompt.images.length > 0 ? { images: prompt.images } : {}),
    })
  }

  return { handleResume, handleRetryLast }
}
