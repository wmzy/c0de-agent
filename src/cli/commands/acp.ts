import readline from 'node:readline/promises'
import type { LoopDeps } from '../../core/loop.js'
import { createSession, listSessions } from '../../session/session.js'
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
      const session = await createSession(deps.db, title)
      return { sessionId: session.id }
    },
    'session/list': async () => {
      const sessions = await listSessions(deps.db)
      return { sessions }
    },
    chat: async (params) => {
      const message = params.message as string | undefined
      if (!message) throw new Error('chat: message is required')
      const text = await runPrintMode(config, message, deps, {
        onEvent: (e) => opts.onEvent('event', e as unknown as Record<string, unknown>),
      })
      return { text }
    },
    abort: async () => ({ ok: true }),
    'tool/confirm': async () => ({ ok: true }),
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
