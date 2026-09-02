import type { AgentEvent } from '@shared/types/agent.js'
import type { APIError } from '../types/index.js'
import { getAuthToken } from './api.js'

/** 从单个 SSE 帧文本提取 data 字段并解析为 AgentEvent。 */
export function parseSSEFrame(frame: string): AgentEvent | null {
  const lines = frame.split('\n')
  const dataLines = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart())
  if (dataLines.length === 0) return null
  try {
    return JSON.parse(dataLines.join('\n')) as AgentEvent
  } catch {
    return null
  }
}

/** 解析缓冲区，返回已完整的帧事件 + 剩余未完成文本。 */
export function consumeSSEBuffer(buffer: string): { events: AgentEvent[]; rest: string } {
  const events: AgentEvent[] = []
  let remaining = buffer
  let sep = remaining.indexOf('\n\n')
  while (sep !== -1) {
    const frame = remaining.slice(0, sep)
    const evt = parseSSEFrame(frame)
    if (evt) events.push(evt)
    remaining = remaining.slice(sep + 2)
    sep = remaining.indexOf('\n\n')
  }
  return { events, rest: remaining }
}

/** 发送聊天消息并消费 SSE 流，逐事件回调。返回是否收到 done 事件（false=中断）。 */
async function sendChatMessage(
  sessionId: string,
  message: string,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
  opts?: {
    provider?: string
    model?: string
    tools?: string[]
    agent?: string
    agents?: string[]
    images?: Array<{ mediaType: string; data: string }>
    files?: string[]
  },
): Promise<{ done: boolean }> {
  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }

  const token = getAuthToken()
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 认证（P0-1）：authEnabled 默认开启，/api/chat 与 apiRequest 一样条件携带
      // Bearer 头；否则 401 落入 useChat 的「网络错误视为中断」分支，只见持续中断横幅。
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ sessionId, message, ...opts }),
    signal: controller.signal,
  })

  if (!response.ok) {
    // 后端 apiError 返回 { error: { code, message, details? } }；兼容裸 { message } 与无 JSON（fallback statusText）。
    const body = await response.json().catch(() => ({ message: response.statusText }))
    const errBody = (
      body as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
    ).error
    // 401：token 缺失/过期，附可操作指引（从 serve 输出的 URL 重新进入以携带新 token），
    // 避免只显示裸 statusText。
    const errMessage =
      errBody?.message ?? (body as { message?: string }).message ?? response.statusText
    throw {
      status: response.status,
      message:
        response.status === 401 ? `${errMessage}（认证失败，请从 serve 输出的 URL 重新进入）` : errMessage,
      code: errBody?.code,
      ...(errBody?.details ? { details: errBody.details } : {}),
    } as APIError
  }

  const reader = response.body?.getReader()
  if (!reader) return { done: false }
  const decoder = new TextDecoder()
  let buffer = ''
  let doneReceived = false

  let watchdog: ReturnType<typeof setTimeout> | null = null
  let timedOut = false
  try {
    while (true) {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, 90_000)
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const { events, rest } = consumeSSEBuffer(buffer)
      buffer = rest
      for (const evt of events) {
        if (evt._tag === 'done') doneReceived = true
        onEvent(evt)
      }
    }
  } catch (err) {
    if (timedOut) return { done: false }
    throw err
  } finally {
    if (watchdog) clearTimeout(watchdog)
  }

  return { done: doneReceived }
}

export { sendChatMessage }
