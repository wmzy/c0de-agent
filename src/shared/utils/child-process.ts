// 子进程 stdio 传输骨架（MCP stdio 与 DAP process transport 共用）。
//
// 两侧差异只剩两点：分帧协议（MCP 按行 JSON / DAP Content-Length，留在各自
// transport）与 unref 语义（MCP 服务器随父进程退出自行消亡；DAP 调试器保活到
// 调试会话结束）。事件面此前两处内联复制，统一在本层处理：
//   - child 'error' 与 stdin EPIPE 'error' 仅告警不击穿宿主（无监听器的
//     'error' 事件会崩溃父进程）
//   - stderr 消费并透传（不读会写满 64KB 管道缓冲卡死子进程）
//   - stdout setEncoding('utf8')（StringDecoder 缓冲跨 chunk 的多字节序列）
//   - close 事件分发、write 走 stdin（已销毁丢弃）、close 走 kill（幂等）
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/** wrapChildProcess 的注入差异：三条日志前缀（保持各传输历史文案不变）与 unref。 */
type WrapChildOptions = {
  /** child 'error'（spawn ENOENT 等）告警前缀。 */
  childErrorLabel: string
  /** stdin 'error'（EPIPE 等）告警前缀——子进程崩溃/提前 close 后的管道写入。 */
  stdinErrorLabel: string
  /** stderr 透传前缀。 */
  stderrLabel: string
  /** unref 子进程（不参与父进程事件循环存活）；缺省保持引用。 */
  unref?: boolean
}

/** 把子进程包成通用 IO 骨架：stdout 解码后分发给 onData、close 分发给 onClose、
 *  write 走 stdin（已销毁时丢弃）、close 走 kill（未杀过才杀）。 */
function wrapChildProcess(
  child: ChildProcessWithoutNullStreams,
  opts: WrapChildOptions,
): {
  onData: (handler: (chunk: string) => void) => void
  onClose: (handler: () => void) => void
  write: (chunk: string | Uint8Array) => void
  close: () => void
} {
  if (opts.unref) child.unref()
  const dataHandlers: Array<(chunk: string) => void> = []
  const closeHandlers: Array<() => void> = []

  // spawn 失败（ENOENT 等）：无监听器时 unhandled 'error' 会击穿父进程。
  // 仅记录——随后的 'close' 事件走既有关闭路径 reject pending。
  child.on('error', (err: Error) => {
    console.warn(`${opts.childErrorLabel}${err.message}`)
  })
  // 子进程崩溃/提前 close(0) 时 stdin 管道写入会异步触发 EPIPE 'error'，
  // 该事件发在 stdin socket 上而非 child 上——无监听器同样击穿宿主进程。
  child.stdin.on('error', (err: Error) => {
    console.warn(`${opts.stdinErrorLabel}${err.message}`)
  })
  // setEncoding('utf8') 让流内 StringDecoder 缓冲跨 chunk 的多字节序列：
  // 逐 chunk Buffer.toString() 解码会在 UTF-8 序列被拆成两片时产出 U+FFFD
  // （中文/emoji 输出静默损坏）。
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    for (const h of dataHandlers) h(chunk)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    process.stderr.write(`${opts.stderrLabel}${chunk}`)
  })
  child.on('close', () => {
    for (const h of closeHandlers) h()
  })

  return {
    onData: (handler) => dataHandlers.push(handler),
    onClose: (handler) => closeHandlers.push(handler),
    write: (chunk) => {
      if (!child.stdin.destroyed) child.stdin.write(chunk)
    },
    close: () => {
      if (!child.killed) child.kill()
    },
  }
}

export type { WrapChildOptions }
export { wrapChildProcess }
