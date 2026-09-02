import { resolveRoute } from '../llm/registry.js'
import { appendMessage, getMessages } from '../session/message.js'
import { getLLMSegments } from '../session/session.js'
import { generateId } from '../shared/index.js'
import type { AgentConfig, AgentEvent, AgentState, AgentStatus } from '../shared/types/agent.js'
import type { MessageContent, Session } from '../shared/types/message.js'
import { getLatestTodoPhasesFromMessages } from '../tools/builtin/todo.js'
import { listTools } from '../tools/registry.js'
import { createTokenBudget, estimateBudget } from './context.js'
import { agentLoop } from './loop.js'
import { DEFAULT_SESSION_TITLE, generateSessionTitle } from './title.js'
import type { AgentDependencies } from './types.js'

async function createAgent(
  session: Session,
  config: AgentConfig,
  deps: AgentDependencies,
): Promise<AgentState> {
  const messages = await getMessages(deps.db, session.id)
  const used = estimateBudget(messages)
  // 加载会话已有分段：每次 /api/chat 创建新 agent 时，从 DB 恢复完整段历史，
  // 使本轮新增的 segment/call 追加到既有历史而非覆盖（saveLLMSegments 为全量写回）。
  const segments = await getLLMSegments(deps.db, session.id)

  const allTools = listTools(deps.toolRegistry, { config: {}, cwd: deps.cwd })
  const tools = allTools.filter((t) => config.tools.includes(t.name))

  // 从 registry 解析模型的 contextWindow，使初始 token 预算与真实窗口一致；
  // 解析失败（provider 未注册 / 模型未知）回退到保守的 128k，首轮流式时
  // resolveEffectiveContextWindow 会再纠正。
  let contextWindow = 128_000
  try {
    const { capabilities } = resolveRoute(deps.llmRegistry, config.provider, config.model)
    contextWindow = capabilities.contextWindow
  } catch {
    // provider 未注册或模型未知：保留回退值，loop 首轮会同步
  }
  const tokenBudget = createTokenBudget(contextWindow)

  return {
    id: generateId(),
    session,
    messages,
    tools,
    config,
    status: { _tag: 'idle' },
    abortController: new AbortController(),
    steeringQueue: [],
    segments,
    tokenBudget: { ...tokenBudget, used },
    calibrationFactor: 1.0,
    // 从历史 tool result 恢复 todo 状态（跨 session resume / compaction 后重建）。
    // 遍历所有消息找最后一条带 phases metadata 的 todo result。
    todoPhases: getLatestTodoPhasesFromMessages(messages),
    // 压缩模型覆盖：从全局配置映射到 agent state，compactContext 读取后用于
    // 创建 summarizer。未配置时为 undefined → 回退到会话主模型。
    ...(deps.config.compaction.compactionModel
      ? { compactionModel: deps.config.compaction.compactionModel }
      : {}),
  }
}

async function* runAgent(
  state: AgentState,
  userInput: MessageContent[],
  deps: AgentDependencies,
): AsyncGenerator<AgentEvent> {
  // 幂等重发保护：若 DB 末尾已是相同 user message（服务重启后续传场景），
  // 跳过 append 避免重复。比较 text parts 内容即可区分不同消息。
  const last = state.messages[state.messages.length - 1]
  const isDupUser =
    last?.role === 'user' &&
    last.content.length === userInput.length &&
    last.content.every((p, i) => {
      const q = userInput[i]
      return p._tag === 'text' && q?._tag === 'text' ? p.text === q.text : false
    })

  if (!isDupUser) {
    await appendMessage(deps.db, state.session.id, {
      role: 'user',
      content: userInput,
    })
  }

  // 标题生成用纯文本（join text parts），忽略 image/tool 等非文本 part。
  const titleText = userInput
    .filter((p) => p._tag === 'text')
    .map((p) => (p._tag === 'text' ? p.text : ''))
    .join('')

  // 第一条用户消息后，后台为会话生成简短标题（fire-and-forget）。
  // 条件：标题仍是默认占位 + 持久化前无任何消息（即首条消息）。
  // 失败被吞掉，绝不阻塞主对话流。
  if (state.session.title === DEFAULT_SESSION_TITLE && state.messages.length === 0) {
    void generateSessionTitle(
      {
        db: deps.db,
        llmRegistry: deps.llmRegistry,
        config: deps.config,
        ...(deps.titleChatFn ? { chatFn: deps.titleChatFn } : {}),
      },
      state.session.id,
      titleText,
      state.config.provider,
      state.config.model,
    ).catch(() => {})
  }

  state.status = { _tag: 'running', turnCount: 0 }

  yield* agentLoop(state, deps)
}

function pauseAgent(state: AgentState): void {
  if (state.status._tag !== 'running') return
  state.status = { _tag: 'paused', pauseReason: 'User requested pause' }
}

function resumeAgent(state: AgentState): void {
  if (state.status._tag !== 'paused') return
  state.status = { _tag: 'running', turnCount: 0 }
}

function abortAgent(state: AgentState): void {
  state.abortController.abort()
  if (state.status._tag === 'running' || state.status._tag === 'paused') {
    state.status = { _tag: 'stopped', reason: 'aborted' }
  }
}

function getAgentStatus(state: AgentState): AgentStatus {
  return state.status
}

/** 判断 agent 是否处于暂停态（spec §19.2）。 */
function isAgentPaused(state: AgentState): boolean {
  return state.status._tag === 'paused'
}

export { abortAgent, createAgent, getAgentStatus, isAgentPaused, pauseAgent, resumeAgent, runAgent }
