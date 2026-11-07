import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { wrapChildProcess } from '../shared/utils/child-process.js'
import type { DAPTransport } from './protocol.js'

/** 启动一个调试适配器子进程，将其 stdin/stdout 包装为 DAPTransport。
 *  子进程事件面（error/stdin EPIPE 告警、stderr 消费、close 分发、kill 语义）
 *  见共享层 wrapChildProcess（与 MCP stdio transport 同骨架）——本侧差异只有
 *  分帧（Content-Length，见 protocol.ts）与不 unref：调试会话随进程结束自然
 *  消亡，保持引用让宿主进程等它退出。 */
function createProcessTransport(
  command: string,
  args: string[] = [],
): {
  transport: DAPTransport
  child: ChildProcessWithoutNullStreams
} {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const io = wrapChildProcess(child, {
    childErrorLabel: '[dap] 调试适配器进程错误：',
    stdinErrorLabel: '[dap] 调试适配器 stdin 写入失败（进程可能已退出）：',
    stderrLabel: '[dap] ',
  })

  const transport: DAPTransport = {
    write: io.write,
    onData: io.onData,
    onClose: io.onClose,
    close: io.close,
  }

  return { transport, child }
}

export { createProcessTransport }
