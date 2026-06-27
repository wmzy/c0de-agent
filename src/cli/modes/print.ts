import { createAgent, runAgent } from '../../core/agent.js'
import type { LoopDeps } from '../../core/loop.js'
import { createSession } from '../../session/session.js'
import type { AgentConfig, AgentEvent } from '../../shared/types/agent.js'
import type { Config } from '../../shared/types/config.js'

type PrintOptions = {
  model?: string
  format?: 'text' | 'json'
  maxTokens?: number
  /** 事件观察回调（CLI 用于把 tool/thinking 写到 stderr）。 */
  onEvent?: (event: AgentEvent) => void
}

/** 从事件流累积 assistant 文本。纯函数。 */
function collectAssistantText(events: AgentEvent[]): string {
  let text = ''
  for (const e of events) {
    if (e._tag === 'text_delta') text += e.text
  }
  return text
}

/** Print 模式：临时会话 → agent → 收集文本 → 返回。 */
async function runPrintMode(
  config: Config,
  message: string,
  deps: LoopDeps,
  opts: PrintOptions = {},
): Promise<string> {
  const session = await createSession(deps.db, 'cli-print')

  const agentConfig: AgentConfig = {
    provider: config.defaultProvider,
    model: opts.model ?? config.defaultModel,
    tools: config.tools.enabled,
    plugins: config.plugins.enabled,
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
  }

  const state = await createAgent(session, agentConfig, deps)

  const events: AgentEvent[] = []
  for await (const event of runAgent(state, message, deps)) {
    events.push(event)
    opts.onEvent?.(event)
  }

  return collectAssistantText(events)
}

export type { PrintOptions }
export { collectAssistantText, runPrintMode }
