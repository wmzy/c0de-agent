import { appendMessage, getMessages } from '../session/message.js'
import { generateId } from '../shared/index.js'
import type { AgentConfig, AgentEvent, AgentState, AgentStatus } from '../shared/types/agent.js'
import type { Session } from '../shared/types/message.js'
import { listTools } from '../tools/registry.js'
import { estimateBudget } from './context.js'
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

  const allTools = listTools(deps.toolRegistry, { config: {}, cwd: deps.cwd })
  const tools = allTools.filter((t) => config.tools.includes(t.name))

  return {
    id: generateId(),
    session,
    messages,
    tools,
    config,
    status: { _tag: 'idle' },
    abortController: new AbortController(),
    steeringQueue: [],
    llmDetails: [],
    tokenBudget: {
      total: 128_000,
      reserved: 25_600,
      available: 102_400,
      used,
      keepRecent: 12_800,
    },
  }
}

async function* runAgent(
  state: AgentState,
  userInput: string,
  deps: AgentDependencies,
): AsyncGenerator<AgentEvent> {
  await appendMessage(deps.db, state.session.id, {
    role: 'user',
    content: [{ _tag: 'text', text: userInput }],
  })

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
      userInput,
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

export { abortAgent, createAgent, getAgentStatus, pauseAgent, resumeAgent, runAgent }
