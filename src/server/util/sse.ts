import type { SSEStreamingApi } from 'hono/streaming'

/** SSE error 事件的文案提取：Error.message 优先；非 Error 但带 message 属性的
 *  对象（agentLoop 抛出的失败对象、CommandResult 的 error 变体）取其 message；
 *  其余 String()。chat.ts 各 catch 块此前各持一份略有差异的提取（instanceof
 *  三元 / 裸 String(e) / 带 message-in 收窄），统一为最通用版。 */
export function sseErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message)
  }
  return String(err)
}

/** SSE error 事件信封（chat.ts 与 workflow-run.ts 此前 8 处同构 writeSSE 块的
 *  单一实现）。
 *  - 默认（enveloped）：聊天线协议 { _tag:'error', error:{ _tag:'unexpected',
 *    message } }——前端按 error.message 解析，与 agentLoop 的 error 事件同构。
 *  - flat：REST 工作流通道的原生 error 事件（{ _tag:'error', message }，无
 *    信封），与其无 _tag 包装的 progress/result 事件同为该通道线上协议。
 *  - swallow：吞掉客户端断开导致的 writeSSE reject——finally 善后路径
 *    （unregister/done 补发）不能因一次失败的写入被跳过。 */
export async function emitSseError(
  stream: SSEStreamingApi,
  err: unknown,
  opts: { flat?: boolean; swallow?: boolean } = {},
): Promise<void> {
  const message = sseErrorMessage(err)
  const data = JSON.stringify(
    opts.flat
      ? { _tag: 'error', message }
      : { _tag: 'error', error: { _tag: 'unexpected', message } },
  )
  const write = stream.writeSSE({ event: 'error', data })
  if (opts.swallow) {
    await write.catch(() => {})
    return
  }
  await write
}

/** SSE done 收尾事件（chat/workflow-run 各通道的 `_tag:'done'` 字面量收敛）。
 *  swallow 语义同 emitSseError：finally 善后路径（error 后补发 done）不能因
 *  客户端断开的 writeSSE reject 被跳过。 */
export async function emitSseDone(
  stream: SSEStreamingApi,
  opts: { swallow?: boolean } = {},
): Promise<void> {
  const write = stream.writeSSE({ event: 'done', data: JSON.stringify({ _tag: 'done' }) })
  if (opts.swallow) {
    await write.catch(() => {})
    return
  }
  await write
}
