import type { ChatOpts } from './useChat.js'

/**
 * 草稿页（sessionId===null）发送首条消息时，先创建会话再导航到新会话路由。
 * 由于导航后组件重建，首条消息需跨组件实例传递，故用模块级 Map 暂存：
 * DraftSession 创建会话拿到 newId 后 set(newId, …)，ChatSession 挂载时 get 并消费。
 *
 * 模块级而非持久化：这是「导航即消费」的一次性数据，页面刷新语义上等于放弃该次发送。
 */
export type PendingFirstMessage = {
  text: string
  opts: ChatOpts
}

const pending = new Map<string, PendingFirstMessage>()

export const pendingFirstMessage = {
  set: (sessionId: string, msg: PendingFirstMessage): void => {
    pending.set(sessionId, msg)
  },
  get: (sessionId: string): PendingFirstMessage | undefined => pending.get(sessionId),
  delete: (sessionId: string): void => {
    pending.delete(sessionId)
  },
}
