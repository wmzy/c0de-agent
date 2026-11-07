import type { Prompt } from '@/composer/types.js'
import type { ChatOpts } from '@/hooks/chatState.js'
import { createSessionMirror } from '@/hooks/sessionMirror.js'

/**
 * 草稿页（sessionId===null）发送首条消息时，先创建会话再导航到新会话路由。
 * 由于导航后组件重建，首条消息需跨组件实例传递，故用模块级 Map 暂存：
 * DraftSession 创建会话拿到 newId 后 set(newId, …)，ChatSession 挂载时 get 并消费。
 *
 * 同时镜像到 sessionStorage：会话创建成功后若恰在导航前刷新/关闭标签页，
 * 重开页面仍能消费该消息发送（P1：此前模块级内存导致「会话已建、消息丢失」）。
 * 「Map + 镜像」骨架与降级语义统一在 sessionMirror.ts。
 */
export type PendingFirstMessage = {
  text: string
  opts: ChatOpts
  /**
   * 结构化输入（含引用 pill 的 file/snippet/terminal 片段）。发送失败要把它原样
   * 还回输入框，只留 text 会把 pill 降级成纯文本（引用丢失）。
   */
  prompt?: Prompt
}

const pending = createSessionMirror<PendingFirstMessage>('c0de-agent:pendingFirst:')

export const pendingFirstMessage = {
  set: pending.set,
  get: pending.get,
  delete: pending.delete,
}
