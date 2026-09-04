import { createAgent, runAgent } from '../../core/agent.js'
import type { LoopDeps } from '../../core/loop.js'
import { resolveRoute } from '../../llm/registry.js'
import { createSession, getSession } from '../../session/session.js'
import type { AgentConfig, AgentEvent } from '../../shared/types/agent.js'
import type { Config } from '../../shared/types/config.js'
import { resolveEnabledToolNames } from '../../tools/index.js'

type PrintOptions = {
  model?: string
  format?: 'text' | 'json'
  maxTokens?: number
  /** 续接已有会话（--continue）：加载该会话历史作为上下文。 */
  sessionId?: string
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

/** sessions.id 为 uuid 列：非 uuid 的 --continue 输入会让 PG 直接抛原始
 *  "invalid input syntax for type uuid" SQL 错误。前置校验统一转译为
 *  「session not found」（与不存在的会话同语义），不泄漏 SQL 原文。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Print 模式：临时会话（或 --continue 指定会话）→ agent → 收集文本 → 返回。 */
async function runPrintMode(
  config: Config,
  message: string,
  deps: LoopDeps,
  opts: PrintOptions = {},
): Promise<string> {
  let session: Awaited<ReturnType<typeof getSession>>
  if (opts.sessionId) {
    if (!UUID_PATTERN.test(opts.sessionId)) throw new Error(`session not found: ${opts.sessionId}`)
    const existing = await getSession(deps.db, opts.sessionId)
    if (!existing) throw new Error(`session not found: ${opts.sessionId}`)
    session = existing
  } else {
    session = await createSession(deps.db, 'cli-print', undefined, undefined, 'cli')
  }

  const agentConfig: AgentConfig = {
    provider: config.defaultProvider,
    model: opts.model ?? config.defaultModel,
    // 工具集：enabled 非空 → enabled ∩ registered；空 → 全部 registered（disabled 已在 registry 层过滤）。
    tools: resolveEnabledToolNames(deps.toolRegistry, config),
    plugins: config.plugins.enabled,
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
  }

  // P3：首跑友好报错——未配置 provider 时不再让底层 NoRoute 异常裸抛，
  // 给出与 Web 端一致的引导（c0de serve → 设置 → Provider）。
  try {
    resolveRoute(deps.llmRegistry, agentConfig.provider, agentConfig.model)
  } catch {
    throw new Error(
      '未配置可用的 AI 服务。请运行 `c0de serve` 并在「设置 → Provider」中添加 API 服务并测试连接，' +
        '或使用 `c0de config set` 配置 providers。',
    )
  }

  const state = await createAgent(session, agentConfig, deps)

  const events: AgentEvent[] = []
  for await (const event of runAgent(state, [{ _tag: 'text', text: message }], deps)) {
    events.push(event)
    opts.onEvent?.(event)
  }

  return collectAssistantText(events)
}

export type { PrintOptions }
export { collectAssistantText, runPrintMode }
