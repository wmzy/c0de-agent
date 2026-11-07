import type { ComposerSendPayload, ImagePart } from '@/composer/types.js'
import { createSessionMirror } from '@/hooks/sessionMirror.js'

/**
 * 发送失败后「消息 + 失败原因」的跨路由传递。
 *
 * 新会话首条消息失败时，ChatSession 会删掉空会话并导航回草稿页——组件卸载，
 * useChat 里的 error 和输入框里的草稿一起消失：用户回到一个干净的欢迎页，
 * 不知道发生了什么，也不知道该去改哪项设置（provider / 模型 / 网络）。
 * 要修好必须把这两样都带过去。
 *
 * 用模块级 Map 按 projectId 暂存，草稿页挂载时消费一次即删（与 pendingFirstMessage
 * 同一套路，不把状态提到路由之上；「Map + sessionStorage 镜像」骨架见
 * sessionMirror.ts，含配额不足时降级为仅内存的语义）。
 */
export type FailedSend = {
  /** 后端给出的失败原因（已带中文兜底）。 */
  reason: string
  /** 待还原的输入：文本/引用 pill 结构与图片附件。 */
  payload: Pick<ComposerSendPayload, 'text' | 'prompt' | 'images'> & { files: string[] }
}

const failedSend = createSessionMirror<FailedSend>('c0de-agent:failedSend:')

export const failedSendReason = {
  set: failedSend.set,
  /** 取走并清除（消费语义）。无记录返回 null。 */
  take: failedSend.take,
  delete: failedSend.delete,
}

export type { ImagePart }
