import { createAgent, runAgent } from '../../core/agent.js'
import type { LoopDeps } from '../../core/loop.js'
import { resolveRoute } from '../../llm/registry.js'
import { getByDirectory } from '../../project/index.js'
import { createSession, getSession, upgradeTemporarySession } from '../../session/session.js'
import type { AgentConfig, AgentEvent } from '../../shared/types/agent.js'
import type { Config } from '../../shared/types/config.js'
import { PROJECT_BOUND_TOOLS, resolveEnabledToolNames } from '../../tools/index.js'

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
    // M2：会话在回收站（Web 已删除）时拒绝续接——否则消息会写入一个 Web 树
    // 不可见的会话，与「删除」心智模型冲突。给出可操作的恢复途径。
    if (existing.deletedAt) {
      throw new Error(
        `该会话在回收站中（已删除）。请先在 Web 界面回收站中恢复，` +
          `或停止 serve 后运行 \`c0de sessions restore ${opts.sessionId}\` 恢复，再续接。`,
      )
    }
    // 续接即升级为持久会话：30 天临时清理不再触及（P1：此前 --continue 的
    // 会话同样会在 30 天不活动后被物理删除，用户显式续接的历史静默丢失）。
    if (existing.agentType === 'print') {
      await upgradeTemporarySession(deps.db, opts.sessionId)
    }
    session = existing
  } else {
    // agentType='print'：一次性 print 会话标记。purgeTemporarySessions 仅清理
    // print/workflow 会话；普通 CLI 会话（ACP 等）与 --continue 续接的历史永不误删。
    // P1-2 CLI/Web 同树：cwd 已注册为项目时直接绑定（续接后 Web 树按项目可见）；
    // worktreePath 落盘——Web 打开时工具在原目录执行，而非回退 serve cwd。
    const existing = await getByDirectory(deps.db, deps.cwd)
    session = await createSession(
      deps.db,
      'cli-print',
      existing?.id,
      'print',
      'cli',
      undefined,
      deps.cwd,
    )
  }

  const agentConfig: AgentConfig = {
    provider: config.defaultProvider,
    model: opts.model ?? config.defaultModel,
    // 工具集：enabled 含 '*' → 全部 registered；空 → 无工具（fail-closed）；否则 enabled ∩ registered
    // （disabled 已在 registry 层过滤）。无项目绑定（cwd 未注册为项目）时剔除
    // 项目绑定工具（kanban 等）——其 store 不会被注入，调用必失败。
    tools: resolveEnabledToolNames(deps.toolRegistry, config).filter(
      (n) => Boolean(session.projectId) || !PROJECT_BOUND_TOOLS.has(n),
    ),
    plugins: config.plugins.enabled,
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
  }

  // P3：首跑友好报错——未配置 provider 时不再让底层 NoRoute 异常裸抛，
  // 给出与 Web 端一致的引导（c0de serve → 设置 → Provider）。
  // P1-3：区分三种失败（此前一律报「未配置」，配置了 provider 的用户被误导）：
  //  - 完全没有配置 provider → 引导添加；
  //  - provider 名不匹配（如 defaultProvider 仍是默认 'openai'，只配了 anthropic）
  //    → 列出已配置清单 + 修正指引（与 Web PROVIDER_NOT_FOUND 对齐）；
  //  - provider 声明了模型清单但请求模型不在其中 → 列出可用模型（与 Web
  //    MODEL_NOT_FOUND 对齐）。
  try {
    resolveRoute(deps.llmRegistry, agentConfig.provider, agentConfig.model)
  } catch {
    if (config.providers.length === 0) {
      throw new Error(
        '未配置可用的 AI 服务。请运行 `c0de serve` 并在「设置 → Provider」中添加 API 服务并测试连接，' +
          '或使用 `c0de config set` 配置 providers。',
      )
    }
    const configured = config.providers
      .map((p) => p.name)
      .filter(Boolean)
      .join(', ')
    throw new Error(
      `未找到名为「${agentConfig.provider}」的 AI 服务。已配置：${configured}。` +
        `请检查拼写，或用 \`c0de config set defaultProvider <name>\` 修正默认服务。`,
    )
  }
  const providerDef = config.providers.find((p) => p.name === agentConfig.provider)
  const modelNames = providerDef?.models ? Object.keys(providerDef.models) : undefined
  if (modelNames && modelNames.length > 0 && !modelNames.includes(agentConfig.model)) {
    throw new Error(
      `provider「${agentConfig.provider}」没有名为「${agentConfig.model}」的模型。` +
        `已配置模型：${modelNames.join(', ')}（可用 \`c0de chat --model <model>\` 指定）。`,
    )
  }

  const state = await createAgent(session, agentConfig, deps)

  const events: AgentEvent[] = []
  for await (const event of runAgent(state, [{ _tag: 'text', text: message }], deps)) {
    events.push(event)
    opts.onEvent?.(event)
  }

  // 终态错误（unexpected，含预算中止）必须反馈给用户而非静默返回半截文本——
  // 抛出后 dispatch 打印 message 并以非零码退出（预算超支中止等硬性护栏由此可见）。
  const terminal = events.find((e) => e._tag === 'error' && e.error._tag === 'unexpected')
  if (terminal && terminal._tag === 'error' && terminal.error._tag === 'unexpected') {
    throw new Error(terminal.error.message)
  }

  return collectAssistantText(events)
}

export type { PrintOptions }
export { collectAssistantText, runPrintMode }
