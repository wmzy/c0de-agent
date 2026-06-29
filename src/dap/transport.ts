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

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    for (const h of dataHandlers) h(chunk)
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
