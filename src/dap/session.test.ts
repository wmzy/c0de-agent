import { describe, expect, it } from 'vitest'
import { createFramer, type DAPTransport, encodeMessage } from './protocol.js'
import { createDebugSessionManager } from './session.js'
import type { DAPConfig } from './types.js'

type RecordedRequest = { command: string; args?: unknown }

type HarnessOptions = {
  /** initialize 响应体（能力位）；默认 {}。 */
  initBody?: Record<string, unknown>
  /** true：launch/attach 响应在收到 configurationDone 之后才回（js-debug 行为）。 */
  launchWaitsForConfigurationDone?: boolean
}

/** 记录每个请求的自动应答 transport（同 dap.test.ts 的 harness，附请求日志）。 */
function recordingTransport(log: RecordedRequest[], opts: HarnessOptions = {}): DAPTransport {
  const dataHandlers: Array<(chunk: string | Uint8Array) => void> = []
  const framer = createFramer()
  const heldLaunch: Array<{ seq: number }> = []
  const reply = (seq: number, body: unknown): void => {
    const resp = encodeMessage(
      JSON.stringify({
        seq: 10_000 + seq,
        type: 'response',
        request_seq: seq,
        success: true,
        body,
      }),
    )
    for (const h of dataHandlers) h(resp)
  }
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
          : msg.command === 'initialize'
            ? (opts.initBody ?? {})
            : {}
    // js-debug 式互锁：launch 响应挂起，直到 configurationDone 到达才回。
    if (
      opts.launchWaitsForConfigurationDone &&
      (msg.command === 'launch' || msg.command === 'attach')
    ) {
      heldLaunch.push({ seq: msg.seq })
      return
    }
    if (msg.command === 'configurationDone' && heldLaunch.length > 0) {
      reply(msg.seq, body)
      for (const held of heldLaunch.splice(0)) reply(held.seq, {})
      return
    }
    reply(msg.seq, body)
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

describe('createDebugSessionManager — 启动握手', () => {
  // 复现 1：launch 参数缺 `type` 时 js-debug 不创建调试目标，launch 请求永不返回
  // 响应（实测：initialize 后 launch 挂起 10s+ 无响应，目标不运行），start() 只能
  // 等到 initialize 超时（120s）才报错，且错误文本不指向根因。
  it('launch 参数带 type（适配器 id），launchArgs 可覆盖', async () => {
    const log: RecordedRequest[] = []
    const manager = createDebugSessionManager()
    await manager.start(() => recordingTransport(log), {
      adapter: 'node',
      program: '/tmp/app.mjs',
      cwd: '/tmp',
      launchArgs: { stopOnEntry: true },
    })
    const launch = log.find((r) => r.command === 'launch')
    expect(launch?.args).toMatchObject({
      type: 'node',
      program: '/tmp/app.mjs',
      cwd: '/tmp',
      stopOnEntry: true,
    })
  })

  // 复现 2：适配器声明 supportsConfigurationDoneRequest（js-debug）时客户端必须
  // 发 configurationDone，否则目标永不启动、断点永不命中。此前客户端从不发送。
  it('适配器声明 supportsConfigurationDoneRequest 时补发 configurationDone', async () => {
    const log: RecordedRequest[] = []
    const manager = createDebugSessionManager()
    await manager.start(
      () => recordingTransport(log, { initBody: { supportsConfigurationDoneRequest: true } }),
      CONFIG,
    )
    const commands = log.map((r) => r.command)
    expect(commands).toContain('configurationDone')
    // 顺序：initialize → launch → configurationDone（js-debug 要收到
    // configurationDone 才回 launch 响应，先 await launch 会互锁）
    expect(commands.indexOf('launch')).toBeLessThan(commands.indexOf('configurationDone'))
  })

  it('未声明该能力的适配器不发 configurationDone', async () => {
    const log: RecordedRequest[] = []
    const { manager, sessionId } = await startSession(log)
    expect(log.map((r) => r.command)).not.toContain('configurationDone')
    expect(manager.getSession(sessionId)?.state).toBe('running')
  })

  // js-debug 行为仿真：launch 响应挂起直到 configurationDone 到达。修复前
  // start() 先 await launch（无人发 configurationDone）→ 死等到超时。
  it('launch 响应依赖 configurationDone 时 start() 仍能完成', { timeout: 5000 }, async () => {
    const log: RecordedRequest[] = []
    const manager = createDebugSessionManager()
    const { sessionId } = await manager.start(
      () =>
        recordingTransport(log, {
          initBody: { supportsConfigurationDoneRequest: true },
          launchWaitsForConfigurationDone: true,
        }),
      CONFIG,
    )
    expect(sessionId).toBeTruthy()
    expect(log.map((r) => r.command)).toEqual(['initialize', 'launch', 'configurationDone'])
  })
})
