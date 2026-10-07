import type { ComposerSendPayload, ImagePart } from '@/composer/types.js'

/**
 * 发送失败后「消息 + 失败原因」的跨路由传递。
 *
 * 新会话首条消息失败时，ChatSession 会删掉空会话并导航回草稿页——组件卸载，
 * useChat 里的 error 和输入框里的草稿一起消失：用户回到一个干净的欢迎页，
 * 不知道发生了什么，也不知道该去改哪项设置（provider / 模型 / 网络）。
 * 要修好必须把这两样都带过去。
 *
 * 用模块级 Map 按 projectId 暂存，草稿页挂载时消费一次即删（与 pendingFirstMessage
 * 同一套路，不把状态提到路由之上）。同 sessionStorage 镜像：清理会话到导航之间
 * 恰好刷新页面时，消息不至于丢失（图片体积大，存不下时静默降级为仅内存）。
 */
export type FailedSend = {
  /** 后端给出的失败原因（已带中文兜底）。 */
  reason: string
  /** 待还原的输入：文本/引用 pill 结构与图片附件。 */
  payload: Pick<ComposerSendPayload, 'text' | 'prompt' | 'images'> & { files: string[] }
}

const KEY_PREFIX = 'c0de-agent:failedSend:'

const failed = new Map<string, FailedSend>()

function loadFromStorage(projectId: string): FailedSend | null {
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + projectId)
    return raw ? (JSON.parse(raw) as FailedSend) : null
  } catch {
    return null
  }
}

export const failedSendReason = {
  set: (projectId: string, value: FailedSend): void => {
    failed.set(projectId, value)
    try {
      sessionStorage.setItem(KEY_PREFIX + projectId, JSON.stringify(value))
    } catch {
      // 配额不足（大图 base64 等）：仅本次内存传递
    }
  },
  /** 取走并清除（消费语义）。无记录返回 null。 */
  take: (projectId: string): FailedSend | null => {
    const value = failed.get(projectId) ?? loadFromStorage(projectId)
    if (!value) return null
    failedSendReason.delete(projectId)
    return value
  },
  delete: (projectId: string): void => {
    failed.delete(projectId)
    try {
      sessionStorage.removeItem(KEY_PREFIX + projectId)
    } catch {
      // 尽力删除；残留会在下次 take 时被消费一次
    }
  },
}

export type { ImagePart }
