import { generateId } from '../shared/index.js'
import { createDAPClient, type DAPClient, type DAPTransport } from './protocol.js'
import type { Breakpoint, DAPConfig, DAPSession, StackFrame, Variable } from './types.js'

/** spawn 一个调试适配器并返回其 stdio 包装的 transport（由 host 注入）。 */
type DebugSpawn = (config: DAPConfig) => DAPTransport

// ── 基于已建立 client 的原子操作（薄封装，对齐 DAP command） ──

async function dapInitialize(client: DAPClient, adapterID: string): Promise<unknown> {
  return client.request('initialize', {
    clientID: 'c0de-agent',
    adapterID,
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: 'path',
  })
}

async function dapLaunch(client: DAPClient, config: DAPConfig): Promise<void> {
  const cmd = config.request === 'attach' ? 'attach' : 'launch'
  await client.request(cmd, {
    program: config.program,
    args: config.args,
    cwd: config.cwd,
    stopOnEntry: false,
    ...config.launchArgs,
  })
}

async function dapSetBreakpoints(
  client: DAPClient,
  file: string,
  bps: Breakpoint[],
): Promise<unknown> {
  return client.request('setBreakpoints', {
    source: { path: file },
    breakpoints: bps.map((b) => ({ line: b.line, condition: b.condition })),
  })
}

async function dapContinue(client: DAPClient, threadId: number): Promise<unknown> {
  return client.request('continue', { threadId })
}

async function dapStep(
  client: DAPClient,
  threadId: number,
  kind: 'over' | 'in' | 'out',
): Promise<unknown> {
  const command = kind === 'in' ? 'stepIn' : kind === 'out' ? 'stepOut' : 'next'
  return client.request(command, { threadId })
}

async function dapStackTrace(client: DAPClient, threadId: number): Promise<StackFrame[]> {
  const body = (await client.request('stackTrace', { threadId })) as
    | { stackFrames?: StackFrame[] }
    | undefined
  return body?.stackFrames ?? []
}

/** 按帧取变量：先 scopes 得到 variablesReference，再 variables 汇总。 */
async function dapVariables(client: DAPClient, frameId: number): Promise<Variable[]> {
  const scopesBody = (await client.request('scopes', { frameId })) as
    | { scopes?: Array<{ variablesReference?: number }> }
    | undefined
  const refs = scopesBody?.scopes ?? []
  const out: Variable[] = []
  for (const s of refs) {
    if (s.variablesReference === undefined) continue
    const vBody = (await client.request('variables', {
      variablesReference: s.variablesReference,
    })) as { variables?: Variable[] } | undefined
    out.push(...(vBody?.variables ?? []))
  }
  return out
}

async function dapEvaluate(
  client: DAPClient,
  frameId: number,
  expression: string,
): Promise<string> {
  const body = (await client.request('evaluate', { expression, frameId, context: 'repl' })) as
    | { result?: string }
    | undefined
  return body?.result ?? ''
}

// ── 会话管理器（模块级 Map，注入 spawn 能力） ──

type ManagedSession = {
  session: DAPSession
  client: DAPClient
  config: DAPConfig
}

type DebugSessionManager = {
  start: (
    spawn: DebugSpawn,
    config: DAPConfig,
  ) => Promise<{ sessionId: string; threadId: number | null }>
  setBreakpoint: (sessionId: string, bp: Breakpoint) => Promise<unknown>
  continue: (sessionId: string, threadId: number) => Promise<unknown>
  step: (sessionId: string, threadId: number, kind: 'over' | 'in' | 'out') => Promise<unknown>
  stack: (sessionId: string, threadId: number) => Promise<StackFrame[]>
  variables: (sessionId: string, frameId: number) => Promise<Variable[]>
  evaluate: (sessionId: string, frameId: number, expression: string) => Promise<string>
  stop: (sessionId: string) => Promise<void>
  getSession: (sessionId: string) => DAPSession | undefined
}

function createDebugSessionManager(): DebugSessionManager {
  const sessions = new Map<string, ManagedSession>()

  const require = (sessionId: string): ManagedSession => {
    const s = sessions.get(sessionId)
    if (!s) throw new Error(`DAP session "${sessionId}" not found`)
    return s
  }

  return {
    async start(spawn, config) {
      const transport = spawn(config)
      const client = createDAPClient(transport)
      const session: DAPSession = {
        id: generateId(),
        adapter: config.adapter,
        program: config.program,
        state: 'running',
      }
      let lastThread: number | null = null
      client.on('stopped', (body) => {
        session.state = 'paused'
        const tid = (body as { threadId?: number } | undefined)?.threadId
        if (typeof tid === 'number') lastThread = tid
      })
      client.on('terminated', () => {
        session.state = 'stopped'
      })

      await dapInitialize(client, config.adapter)
      await dapLaunch(client, config)
      sessions.set(session.id, { session, client, config })
      return { sessionId: session.id, threadId: lastThread }
    },
    setBreakpoint(sessionId, bp) {
      return dapSetBreakpoints(require(sessionId).client, bp.file, [bp])
    },
    continue(sessionId, threadId) {
      return dapContinue(require(sessionId).client, threadId)
    },
    step(sessionId, threadId, kind) {
      return dapStep(require(sessionId).client, threadId, kind)
    },
    stack(sessionId, threadId) {
      return dapStackTrace(require(sessionId).client, threadId)
    },
    variables(sessionId, frameId) {
      return dapVariables(require(sessionId).client, frameId)
    },
    evaluate(sessionId, frameId, expression) {
      return dapEvaluate(require(sessionId).client, frameId, expression)
    },
    async stop(sessionId) {
      const s = sessions.get(sessionId)
      if (!s) return
      s.session.state = 'stopped'
      // disconnect 适配器可能已退出；吞错。
      try {
        await s.client.request('disconnect', {})
      } catch {
        /* adapter gone */
      }
      s.client.dispose()
      sessions.delete(sessionId)
    },
    getSession(sessionId) {
      return sessions.get(sessionId)?.session
    },
  }
}

export type { DebugSessionManager, DebugSpawn }
export { createDebugSessionManager, dapVariables }
