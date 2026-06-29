import { describe, expect, it } from 'vitest'
import { createFramer, encodeMessage } from '../../dap/protocol.js'
import type { DebugTransport, ToolContext } from '../../shared/types/tool.js'
import {
  debugBreakpointTool,
  debugContinueTool,
  debugEvalTool,
  debugStackTool,
  debugStartTool,
  debugStepTool,
  debugStopTool,
  debugVarsTool,
} from './dap.js'

/** Auto-responding transport: every request gets a canned success response. */
function autoRespondTransport(): DebugTransport {
  const dataH: Array<(c: string | Uint8Array) => void> = []
  const framer = createFramer()
  framer.onMessage((json) => {
    const msg = JSON.parse(json) as { type: string; seq: number; command: string }
    if (msg.type !== 'request') return
    const body = bodyFor(msg.command)
    const resp = encodeMessage(
      JSON.stringify({
        seq: 10000 + msg.seq,
        type: 'response',
        request_seq: msg.seq,
        success: true,
        body,
      }),
    )
    for (const h of dataH) h(resp)
  })
  return {
    write: (chunk) => framer.feed(chunk),
    onData: (h) => dataH.push(h),
    onClose: () => {},
    close: () => {},
  }
}

function bodyFor(command: string): unknown {
  switch (command) {
    case 'initialize':
    case 'launch':
    case 'attach':
      return {}
    case 'setBreakpoints':
      return { breakpoints: [{ verified: true, line: 5 }] }
    case 'continue':
      return { allThreadsContinued: false }
    case 'next':
    case 'stepIn':
    case 'stepOut':
      return {}
    case 'stackTrace':
      return { stackFrames: [{ id: 7, name: 'main', file: 'app.js', line: 5, column: 1 }] }
    case 'scopes':
      return { scopes: [{ name: 'Locals', variablesReference: 1 }] }
    case 'variables':
      return { variables: [{ name: 'x', value: '42', type: 'number' }] }
    case 'evaluate':
      return { result: '42' }
    case 'disconnect':
      return {}
    default:
      return {}
  }
}

function baseCtx(): ToolContext {
  return {
    cwd: '/tmp',
    session: { id: 's1', cwd: '/tmp' },
    abort: new AbortController().signal,
    debugSpawn: () => autoRespondTransport(),
  }
}

describe('debug_* tools', () => {
  it('debug_start fails when no spawn is wired', async () => {
    const ctx = baseCtx()
    delete ctx.debugSpawn
    const r = await debugStartTool.execute({ adapter: 'node', program: 'app.js' }, ctx)
    expect(r._tag).toBe('error')
    if (r._tag === 'error') expect(r.error).toContain('no debug adapter spawn')
  })

  it('debug_start returns a sessionId', async () => {
    const r = await debugStartTool.execute({ adapter: 'node', program: 'app.js' }, baseCtx())
    expect(r._tag).toBe('success')
    if (r._tag === 'success') {
      const parsed = JSON.parse(r.output) as { sessionId: string }
      expect(parsed.sessionId).toBeTruthy()
    }
  })

  it('debug_breakpoint / continue / step succeed', async () => {
    const ctx = baseCtx()
    const start = await debugStartTool.execute({ adapter: 'node', program: 'app.js' }, ctx)
    const { sessionId } = JSON.parse((start as { output: string }).output) as { sessionId: string }

    expect(
      (await debugBreakpointTool.execute({ sessionId, file: 'app.js', line: 5 }, ctx))._tag,
    ).toBe('success')
    expect((await debugContinueTool.execute({ sessionId, threadId: 1 }, ctx))._tag).toBe('success')
    expect((await debugStepTool.execute({ sessionId, threadId: 1, kind: 'over' }, ctx))._tag).toBe(
      'success',
    )
  })

  it('debug_stack returns frames', async () => {
    const ctx = baseCtx()
    const start = await debugStartTool.execute({ adapter: 'node', program: 'app.js' }, ctx)
    const { sessionId } = JSON.parse((start as { output: string }).output) as { sessionId: string }

    const r = await debugStackTool.execute({ sessionId, threadId: 1 }, ctx)
    expect(r._tag).toBe('success')
    if (r._tag === 'success') {
      const frames = JSON.parse(r.output) as Array<{ id: number }>
      expect(frames[0]?.id).toBe(7)
    }
  })

  it('debug_vars resolves variables via scopes', async () => {
    const ctx = baseCtx()
    const start = await debugStartTool.execute({ adapter: 'node', program: 'app.js' }, ctx)
    const { sessionId } = JSON.parse((start as { output: string }).output) as { sessionId: string }

    const r = await debugVarsTool.execute({ sessionId, frameId: 7 }, ctx)
    expect(r._tag).toBe('success')
    if (r._tag === 'success') {
      const vars = JSON.parse(r.output) as Array<{ name: string; value: string }>
      expect(vars[0]?.value).toBe('42')
    }
  })

  it('debug_eval returns the result', async () => {
    const ctx = baseCtx()
    const start = await debugStartTool.execute({ adapter: 'node', program: 'app.js' }, ctx)
    const { sessionId } = JSON.parse((start as { output: string }).output) as { sessionId: string }

    const r = await debugEvalTool.execute({ sessionId, frameId: 7, expression: 'x' }, ctx)
    expect(r._tag).toBe('success')
    if (r._tag === 'success') expect(r.output).toBe('42')
  })

  it('debug_stop stops the session', async () => {
    const ctx = baseCtx()
    const start = await debugStartTool.execute({ adapter: 'node', program: 'app.js' }, ctx)
    const { sessionId } = JSON.parse((start as { output: string }).output) as { sessionId: string }

    const r = await debugStopTool.execute({ sessionId }, ctx)
    expect(r._tag).toBe('success')
  })

  it('operations on unknown sessionId fail', async () => {
    const r = await debugContinueTool.execute({ sessionId: 'nope', threadId: 1 }, baseCtx())
    expect(r._tag).toBe('error')
  })
})
