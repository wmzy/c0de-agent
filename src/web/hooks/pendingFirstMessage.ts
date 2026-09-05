import type { ChatOpts } from './useChat.js'

/**
 * 草稿页（sessionId===null）发送首条消息时，先创建会话再导航到新会话路由。
 * 由于导航后组件重建，首条消息需跨组件实例传递，故用模块级 Map 暂存：
 * DraftSession 创建会话拿到 newId 后 set(newId, …)，ChatSession 挂载时 get 并消费。
 *
 * 同时镜像到 sessionStorage：会话创建成功后若恰在导航前刷新/关闭标签页，
 * 重开页面仍能消费该消息发送（P1：此前模块级内存导致「会话已建、消息丢失」）。
 * 存储配额不足（大图 base64 等）时静默降级为仅内存传递。
 */
export type PendingFirstMessage = {
  text: string
  opts: ChatOpts
}

const PENDING_KEY_PREFIX = 'c0de-agent:pendingFirst:'

const pending = new Map<string, PendingFirstMessage>()

function loadFromStorage(sessionId: string): PendingFirstMessage | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY_PREFIX + sessionId)
    return raw ? (JSON.parse(raw) as PendingFirstMessage) : null
  } catch {
    return null
  }
}

export const pendingFirstMessage = {
  set: (sessionId: string, msg: PendingFirstMessage): void => {
    pending.set(sessionId, msg)
    try {
      sessionStorage.setItem(PENDING_KEY_PREFIX + sessionId, JSON.stringify(msg))
    } catch {
      // 配额/隐私模式：仅本次内存传递
    }
  },
  get: (sessionId: string): PendingFirstMessage | undefined => {
    if (pending.has(sessionId)) return pending.get(sessionId)
    const fromStorage = loadFromStorage(sessionId)
    if (fromStorage) pending.set(sessionId, fromStorage)
    return fromStorage ?? undefined
  },
  delete: (sessionId: string): void => {
    pending.delete(sessionId)
    try {
      sessionStorage.removeItem(PENDING_KEY_PREFIX + sessionId)
    } catch {
      // 忽略：内存已删，残留项下次 get 仍会消费重发——为防重复发送，尽力删除
    }
  },
}
