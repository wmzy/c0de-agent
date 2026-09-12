import readline from 'node:readline/promises'
import type { LoopDeps } from '../../core/loop.js'
import { getByDirectory } from '../../project/index.js'
import { createSession, listAllSessions } from '../../session/session.js'
import type { Config } from '../../shared/types/config.js'
import type { ACPHandler } from '../modes/acp.js'
import { formatACPEvent, runAcpLoop } from '../modes/acp.js'
import { runPrintMode } from '../modes/print.js'

type AcpHandlersOptions = {
  onEvent: (method: string, params: Record<string, unknown>) => void
}

/** 构造 ACP method → handler 映射。chat 复用 Print 模式。 */
function createAcpHandlers(
  config: Config,
  deps: LoopDeps,
  opts: AcpHandlersOptions,
): Record<string, ACPHandler> {
  return {
    'session/create': async (params) => {
      const title = (params.title as string | undefined) ?? 'acp-session'
      // P1-2 CLI/Web 同树：cwd 已注册为项目时直接绑定；worktreePath 落盘保证
      // Web 打开时工具在原目录执行。ACP 会话无 print 标记，永不自动清理。
      const existing = await getByDirectory(deps.db, deps.cwd)
      const session = await createSession(
        deps.db,
        title,
        existing?.id,
        undefined,
        'cli',
        undefined,
        deps.cwd,
      )
      return { sessionId: session.id }
    },
    'session/list': async () => {
      const sessions = await listAllSessions(deps.db)
      return { sessions }
    },
    chat: async (params) => {
      const message = params.message as string | undefined
      if (!message) throw new Error('chat: message is required')
      const sessionId = params.sessionId as string | undefined
      const text = await runPrintMode(config, message, deps, {
        ...(sessionId ? { sessionId } : {}),
        onEvent: (e) => opts.onEvent('event', e as unknown as Record<string, unknown>),
      })
      return { text }
    },
    abort: async () => ({ ok: true }),
  }
}

/** 写一行 ACP event 到给定 writer（命令层用于接 stdout）。 */
function writeAcpEvent(
  writer: (line: string) => void,
  method: string,
  params: Record<string, unknown>,
): void {
  writer(formatACPEvent(method, params))
}

type AcpCommandContext = {
  config: Config
  deps: LoopDeps
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
}

async function runAcpCommand(ctx: AcpCommandContext): Promise<void> {
  const out = ctx.stdout ?? process.stdout
  const rl = readline.createInterface({ input: ctx.stdin ?? process.stdin })

  async function* reader(): AsyncGenerator<string> {
    for await (const line of rl) yield line
  }

  const handlers = createAcpHandlers(ctx.config, ctx.deps, {
    onEvent: (_method, params) => out.write(`${formatACPEvent('event', params)}\n`),
  })

  await runAcpLoop({
    reader: reader(),
    writer: (line) => out.write(`${line}\n`),
    handlers,
  })
}

export type { AcpCommandContext, AcpHandlersOptions }
export { createAcpHandlers, runAcpCommand, writeAcpEvent }
