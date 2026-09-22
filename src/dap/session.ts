import { generateId } from '../shared/index.js'
import { createDAPClient, type DAPClient, type DAPTransport } from './protocol.js'
import type { Breakpoint, DAPConfig, DAPSession, StackFrame, Variable } from './types.js'

/** spawn 一个调试适配器并返回其 stdio 包装的 transport（由 host 注入）。 */
type DebugSpawn = (config: DAPConfig) => DAPTransport

// ── 基于已建立 client 的原子操作（薄封装，对齐 DAP command） ──

/** initialize 超时：适配器首启（如 npx 下载 js-debug）可慢，给足余量；
 *  超时关闭 transport 并抛错，避免 debug_start 永久挂住 agent run。 */
const DAP_INIT_TIMEOUT_MS = 120_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

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
  /** 已设置断点（file → 该文件的完整断点集）。
   *  DAP 的 setBreakpoints 是「替换该 source 的整个断点集」语义——一个 source 的
   *  多个断点必须放进同一次请求。而 debug_breakpoint 是逐条调用的增量 API：
   *  不在此累积的话，第二次调用同一文件会把第一次的断点从适配器里抹掉，两次
   *  调用却都回 success（agent 以为两个断点都生效，实际只剩最后一个）。 */
  breakpoints: Map<string, Breakpoint[]>
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

      try {
        await withTimeout(
          dapInitialize(client, config.adapter),
          DAP_INIT_TIMEOUT_MS,
          'DAP initialize',
        )
        await dapLaunch(client, config)
      } catch (e) {
        // 握手/launch 失败：dispose 关闭 transport（杀适配器子进程），不留悬挂会话。
        client.dispose()
        throw e
      }
      sessions.set(session.id, { session, client, config, breakpoints: new Map() })
      return { sessionId: session.id, threadId: lastThread }
    },
    setBreakpoint(sessionId, bp) {
      const managed = require(sessionId)
      const existing = managed.breakpoints.get(bp.file) ?? []
      // 同一行重复设置（典型是补/改条件）替换旧条目，其余保留——断点集内不产生重复。
      const next = [...existing.filter((b) => b.line !== bp.line), bp]
      managed.breakpoints.set(bp.file, next)
      return dapSetBreakpoints(managed.client, bp.file, next)
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
      // disconnect 适配器可能已退出；吞错但记录，便于排查非正常退出。
      try {
        await s.client.request('disconnect', {})
      } catch (e) {
        console.warn('[dap] disconnect failed:', e instanceof Error ? e.message : String(e))
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
