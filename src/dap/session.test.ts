import { describe, expect, it } from 'vitest'
import { createFramer, type DAPTransport, encodeMessage } from './protocol.js'
import { createDebugSessionManager } from './session.js'
import type { DAPConfig } from './types.js'

type RecordedRequest = { command: string; args?: unknown }

/** 记录每个请求的自动应答 transport（同 dap.test.ts 的 harness，附请求日志）。 */
function recordingTransport(log: RecordedRequest[]): DAPTransport {
  const dataHandlers: Array<(chunk: string | Uint8Array) => void> = []
  const framer = createFramer()
  framer.onMessage((json) => {
    const msg = JSON.parse(json) as {
      type: string
      seq: number
      command: string
      arguments?: unknown
    }
    if (msg.type !== 'request') return
    log.push({ command: msg.command, args: msg.arguments })
    const body =
      msg.command === 'setBreakpoints'
        ? { breakpoints: [{ verified: true }] }
        : msg.command === 'stackTrace'
          ? { stackFrames: [] }
          : {}
    const resp = encodeMessage(
      JSON.stringify({
        seq: 10_000 + msg.seq,
        type: 'response',
        request_seq: msg.seq,
        success: true,
        body,
      }),
    )
    for (const h of dataHandlers) h(resp)
  })
  return {
    write: (chunk) => framer.feed(chunk),
    onData: (h) => dataHandlers.push(h),
    onClose: () => {},
    close: () => {},
  }
}

const CONFIG: DAPConfig = { adapter: 'test', program: 'app.js' }

async function startSession(log: RecordedRequest[]) {
  const manager = createDebugSessionManager()
  const { sessionId } = await manager.start(() => recordingTransport(log), CONFIG)
  return { manager, sessionId }
}

/** 取某会话发出的全部 setBreakpoints 请求的断点行号。 */
function breakpointLines(log: RecordedRequest[], index = -1): number[] {
  const calls = log.filter((r) => r.command === 'setBreakpoints')
  const call = calls.at(index)
  const bps =
    (call?.args as { breakpoints?: Array<{ line: number }> } | undefined)?.breakpoints ?? []
  return bps.map((b) => b.line)
}

describe('createDebugSessionManager — 断点累积', () => {
  // 复现：DAP 的 setBreakpoints 是「替换该 source 的整个断点集」语义（规范
  // §setBreakpoints：一个 source 的多个断点必须放在同一次请求里）。而
  // debug_breakpoint 工具是逐条调用的增量 API，manager 此前每次只发当前这一条
  // ——第二次调用同一文件时适配器会丢弃第一条，两次调用却都回 success，agent
  // 以为两个断点都已生效，实际只剩最后一个。
  it('第二次设置同文件断点时必须携带已有断点（DAP 为替换语义）', async () => {
    const log: RecordedRequest[] = []
    const { manager, sessionId } = await startSession(log)

    await manager.setBreakpoint(sessionId, { file: 'a.js', line: 5 })
    await manager.setBreakpoint(sessionId, { file: 'a.js', line: 9 })

    expect(breakpointLines(log, 0)).toEqual([5])
    expect(breakpointLines(log, 1)).toEqual([5, 9])
  })

  it('不同文件的断点互不影响', async () => {
    const log: RecordedRequest[] = []
    const { manager, sessionId } = await startSession(log)

    await manager.setBreakpoint(sessionId, { file: 'a.js', line: 5 })
    await manager.setBreakpoint(sessionId, { file: 'b.js', line: 7 })
    await manager.setBreakpoint(sessionId, { file: 'a.js', line: 12 })

    const last = log.filter((r) => r.command === 'setBreakpoints').at(-1)
    const lastArgs = last?.args as { source?: { path?: string } } | undefined
    expect(lastArgs?.source?.path).toBe('a.js')
    expect(breakpointLines(log)).toEqual([5, 12])
  })

  it('同一行重复设置（如更新条件）不产生重复条目', async () => {
    const log: RecordedRequest[] = []
    const { manager, sessionId } = await startSession(log)

    await manager.setBreakpoint(sessionId, { file: 'a.js', line: 5 })
    await manager.setBreakpoint(sessionId, { file: 'a.js', line: 5, condition: 'x > 1' })

    const calls = log.filter((r) => r.command === 'setBreakpoints')
    expect(breakpointLines(log)).toEqual([5])
    const lastArgs = calls.at(-1)?.args as
      | { breakpoints?: Array<{ line: number; condition?: string }> }
      | undefined
    expect(lastArgs?.breakpoints).toEqual([{ line: 5, condition: 'x > 1' }])
  })

  it('会话停止后断点记录一并清理（同 id 复用不串味）', async () => {
    const log: RecordedRequest[] = []
    const { manager, sessionId } = await startSession(log)

    await manager.setBreakpoint(sessionId, { file: 'a.js', line: 5 })
    await manager.stop(sessionId)
    // 新会话（新 id）重新从空集合开始
    const second = await manager.start(() => recordingTransport(log), CONFIG)
    await manager.setBreakpoint(second.sessionId, { file: 'a.js', line: 9 })
    expect(breakpointLines(log)).toEqual([9])
  })
})
