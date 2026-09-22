import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import type { DAPTransport } from './protocol.js'

/** 启动一个调试适配器子进程，将其 stdin/stdout 包装为 DAPTransport。 */
function createProcessTransport(
  command: string,
  args: string[] = [],
): {
  transport: DAPTransport
  child: ChildProcessWithoutNullStreams
} {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })

  const dataHandlers: Array<(chunk: Uint8Array | string) => void> = []
  const closeHandlers: Array<() => void> = []

  // spawn 失败（ENOENT 等）：无监听器时 unhandled 'error' 会击穿父进程。
  // 仅记录——随后的 'close' 事件走既有关闭路径 reject pending。
  child.on('error', (err: Error) => {
    console.warn(`[dap] 调试适配器进程错误：${err.message}`)
  })
  // 调试器进程崩溃/提前 close(0) 时 stdin 管道写入会异步触发 EPIPE 'error'，
  // 该事件发在 stdin socket 上而非 child 上——无监听器同样击穿宿主进程。
  child.stdin.on('error', (err: Error) => {
    console.warn(`[dap] 调试适配器 stdin 写入失败（进程可能已退出）：${err.message}`)
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    for (const h of dataHandlers) h(chunk)
  })
  // 不读取 stderr 会让管道写满卡死子进程：适配器（js-debug 等）向 stderr 输出
  // 日志/崩溃栈，同步写满 64KB 管道缓冲后阻塞在 write(2) 上，stdout 的 DAP 帧
  // 永远发不出来（握手/请求全部等不到响应）。消费并透传到宿主 stderr——与 MCP
  // stdio 传输同口径，同时保住适配器的错误输出可供排查。
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    process.stderr.write(`[dap] ${chunk}`)
  })
  child.on('close', () => {
    for (const h of closeHandlers) h()
  })

  const transport: DAPTransport = {
    write: (chunk) => {
      if (!child.stdin.destroyed) child.stdin.write(chunk)
    },
    onData: (h) => dataHandlers.push(h),
    onClose: (h) => closeHandlers.push(h),
    close: () => {
      if (!child.killed) child.kill()
    },
  }

  return { transport, child }
}

export { createProcessTransport }
