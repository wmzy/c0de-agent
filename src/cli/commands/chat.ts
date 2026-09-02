import type { LoopDeps } from '../../core/loop.js'
import type { Config } from '../../shared/types/config.js'
import { runPrintMode } from '../modes/print.js'
import type { CommandArgs } from '../parser.js'

type ChatCommandContext = {
  args: CommandArgs
  config: Config
  deps: LoopDeps
  stdout?: (s: string) => void
  stderr?: (s: string) => void
}

async function runChatCommand(ctx: ChatCommandContext): Promise<void> {
  const message = ctx.args.positionals.join(' ').trim()
  if (!message) throw new Error('chat: a message is required (c0de chat "your question")')

  const out = ctx.stdout ?? process.stdout.write.bind(process.stdout)
  const err = ctx.stderr ?? process.stderr.write.bind(process.stderr)
  const format = (ctx.args.options.format as 'text' | 'json' | undefined) ?? 'text'
  const model = ctx.args.options.model as string | undefined
  const continueId = ctx.args.options.continue as string | undefined

  const text = await runPrintMode(ctx.config, message, ctx.deps, {
    ...(model ? { model } : {}),
    ...(continueId ? { sessionId: continueId } : {}),
    onEvent: (e) => {
      if (e._tag === 'tool_call_start') err(`[tool] ${e.tool}\n`)
      else if (e._tag === 'thinking') err(`[thinking] ${e.text}\n`)
    },
  })

  if (format === 'json') {
    out(`${JSON.stringify({ text })}\n`)
  } else {
    out(`${text}\n`)
  }
}

export type { ChatCommandContext }
export { runChatCommand }
