import { sessionGet, sessionRemove, sessionSet } from '@/utils/storage.js'

/**
 * 「模块级 Map + sessionStorage 镜像」的跨组件实例传递骨架（工厂）。
 *
 * 供 pendingFirstMessage / failedSendReason 共用：短命的跨路由状态（首条消息、
 * 发送失败的还原载荷）不提升到全局 store，用模块级 Map 暂存——导航后组件重建
 * 仍可读；同时镜像到 sessionStorage，导航前刷新/关闭标签页导致内存丢失时，
 * 重开页面仍能从镜像恢复。存储配额不足（大图 base64 等）或被禁时静默降级为
 * 仅内存传递（兜底统一在 storage.ts 的 session* 三函数里）。
 *
 * get/take 命中镜像时回写 Map（幂等）：两份手写实现此前漂移——
 * pendingFirstMessage.get 回写、failedSendReason.take 不回写；统一采纳回写，
 * 把「镜像里存在」折叠进内存，后续读取不再触存储。
 */
export function createSessionMirror<T>(keyPrefix: string) {
  const values = new Map<string, T>()

  const loadFromStorage = (key: string): T | null => {
    const raw = sessionGet(keyPrefix + key)
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  const get = (key: string): T | undefined => {
    if (values.has(key)) return values.get(key)
    const fromStorage = loadFromStorage(key)
    if (fromStorage !== null) values.set(key, fromStorage)
    return fromStorage ?? undefined
  }

  const remove = (key: string): void => {
    values.delete(key)
    // 尽力删除；残留的镜像会在下次 get/take 时被消费一次
    sessionRemove(keyPrefix + key)
  }

  return {
    set: (key: string, value: T): void => {
      values.set(key, value)
      sessionSet(keyPrefix + key, JSON.stringify(value))
    },
    get,
    /** 取走并清除（消费语义）。无记录返回 null。 */
    take: (key: string): T | null => {
      const value = get(key) ?? null
      if (value === null) return null
      remove(key)
      return value
    },
    delete: remove,
  }
}
