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

/**
 * CLI 斜杠命令拦截：与 Web chat 路由同语义（P1 跨端一致性）。
 * 此前 print 模式把 /clear、/config 等当普通文本发给 LLM，模型会虚构执行结果；
 * 现在 parseSlashInput + registry 拦截，未启用/未知命令回退与 Web 端一致。
 * /compact 需要会话上下文，由消费方在此执行压缩并输出摘要。
 */
async function runSlashCommand(
  message: string,
  continueId: string | undefined,
  ctx: ChatCommandContext,
): Promise<boolean> {
  const { createSlashRegistry, parseSlashInput } = await import('../../core/slash.js')
  const parsed = parseSlashInput(message)
  if (!parsed) return false
  const registry = createSlashRegistry()
  const cmd = registry.get(parsed.name)
  if (!cmd) return false // 未知斜杠命令：回退为正常消息发给 agent（与 Web 端一致）

  const out = ctx.stdout ?? process.stdout.write.bind(process.stdout)
  const err = ctx.stderr ?? process.stderr.write.bind(process.stderr)
  const enabledList = ctx.config.slashCommands?.enabled ?? []
  const enabledSet = new Set(enabledList.map((n) => (n.startsWith('/') ? n.slice(1) : n)))
  if (enabledSet.size > 0 && !enabledSet.has(parsed.name)) {
    err(`斜杠命令 /${parsed.name} 未启用（config.slashCommands.enabled）\n`)
    return true
  }

  const { compactContext } = await import('../../core/loop.js')
  const { createAgent } = await import('../../core/agent.js')
  const { getSession } = await import('../../session/session.js')

  const result = await cmd.execute(parsed.args, {
    cwd: ctx.deps.cwd,
    config: ctx.config,
    deps: ctx.deps,
    sessionId: continueId,
    // 消费渠道：/model 等命令按渠道给指引（CLI 无底部模型选择器）。
    channel: 'cli',
  })

  if (result._tag === 'compact') {
    // /compact：消费方执行压缩（Web 端由 chat 路由消费）。需要会话上下文。
    if (!continueId) {
      err('/compact 需要会话上下文：请加 --continue <session-id> 指定会话\n')
      return true
    }
    const session = await getSession(ctx.deps.db, continueId)
    if (!session) {
      throw new Error(`session not found: ${continueId}`)
    }
    const agentConfig = {
      provider: ctx.config.defaultProvider,
      model: ctx.config.defaultModel,
      tools: [],
      plugins: ctx.config.plugins.enabled,
      agentName: 'default',
    }
    const state = await createAgent(session, agentConfig, ctx.deps)
    for await (const event of compactContext(state, ctx.deps)) {
      if (event._tag === 'text_delta') out(`${event.text}\n`)
    }
    return true
  }

  if (result._tag === 'error') {
    err(`${result.message}\n`)
    return true
  }
  const text = result._tag === 'success' ? result.message : result.text
  out(`${text}\n`)
  return true
}

async function runChatCommand(ctx: ChatCommandContext): Promise<void> {
  const message = ctx.args.positionals.join(' ').trim()
  if (!message) throw new Error('chat: a message is required (c0de chat "your question")')

  const out = ctx.stdout ?? process.stdout.write.bind(process.stdout)
  const err = ctx.stderr ?? process.stderr.write.bind(process.stderr)
  const format = (ctx.args.options.format as 'text' | 'json' | undefined) ?? 'text'
  const model = ctx.args.options.model as string | undefined
  let continueId = ctx.args.options.continue as string | undefined

  // --continue last：续接最近一次会话，免手抄 UUID（P3 产品发现性）。
  if (continueId === 'last') {
    const { listAllSessions } = await import('../../session/session.js')
    const sessions = await listAllSessions(ctx.deps.db)
    if (sessions.length === 0) {
      throw new Error('chat: no sessions to continue (run c0de chat once first)')
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    continueId = sessions[0]?.id
    if (!continueId) throw new Error('chat: no sessions to continue')
  }

  // 斜杠命令拦截：命中则执行本地语义，不把命令文本发给 LLM。
  if (await runSlashCommand(message, continueId, ctx)) return

  const text = await runPrintMode(ctx.config, message, ctx.deps, {
    ...(model ? { model } : {}),
    ...(continueId ? { sessionId: continueId } : {}),
    onEvent: (e) => {
      if (e._tag === 'tool_call_start') err(`[tool] ${e.tool}\n`)
      else if (e._tag === 'thinking') err(`[thinking] ${e.text}\n`)
      else if (e._tag === 'tool_call_end') {
        // P2-17：非交互模式被拒绝的工具调用，把拒绝原因直接可见地输出给用户
        //（拒绝原因本身含 -y / serve 指引），而不是只留给模型转述。
        const result = e.result as { _tag?: string; reason?: string }
        if (result?._tag === 'deny') {
          err(`[tool] 工具调用已拒绝：${result.reason ?? '需要确认'}\n`)
        }
      }
    },
  })

  if (format === 'json') {
    out(`${JSON.stringify({ text })}\n`)
  } else {
    out(`${text}\n`)
  }

  // P2-5：一次性 CLI 问答不进 Web 会话树，明确告知查看/续接途径，
  // 避免「我的会话去哪了」（--continue 续接时用户已知会话存在，不提示）。
  if (!continueId) {
    err(
      '此问答会话不会出现在 Web 界面；可用 `c0de sessions list` 查看，或 `c0de chat --continue` 续接。\n',
    )
  }
}

export type { ChatCommandContext }
export { runChatCommand }
