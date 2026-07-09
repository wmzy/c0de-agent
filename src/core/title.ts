/**
 * 会话标题自动生成。
 *
 * 设计参考 opencode 的 `ensureTitle`：在第一条用户消息后，用一个 smol/快速
 * 模型为会话生成简短标题。fire-and-forget，失败仅吞掉，绝不阻塞主对话流。
 *
 * 模型解析遵循 chat 路由的同款策略（见 server/routes/chat.ts）：优先
 * `config.roleRouting.smol`，未配置则回退 `defaultProvider/defaultModel`。
 * 不走 registry.resolveModelByRole——因为运行时 buildRegistryFromConfig 只
 * 注册 provider 路由、并未把 roleRouting 绑定到 registry.roles，角色解析会
 * 直接抛 NoRoute。
 */
import type { DB } from '../db/client.js'
import { chat as defaultChat } from '../llm/provider.js'
import type { Registry } from '../llm/registry.js'
import { updateSessionTitle } from '../session/session.js'
import type { ChatMessage, ChatRequest } from '../shared/types/llm.js'
import type { Config } from './config.js'

/** 会话默认占位标题；仍是该值时才有资格自动生成。 */
const DEFAULT_SESSION_TITLE = 'New Session'

/** 标题最长字符数，超出截断并加省略号。 */
const TITLE_MAX_LENGTH = 100

/**
 * 标题生成系统提示。直接移植自 opencode 的 agent/prompt/title.txt（同语义）：
 * 要求与用户消息同语言、语法自然、聚焦主题、保留技术术语，且对极简输入也
 * 给出有意义的标题。中文消息 → 中文标题。
 */
const TITLE_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- ≤50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  → create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" → Debugging production 500 errors
"refactor user service" → Refactoring user service
"why is app.js failing" → app.js failure investigation
"implement rate limiting" → Rate limiting implementation
"how do I connect postgres to my API" → Postgres API connection
"best practices for React hooks" → React hooks best practices
"@src/auth.ts can you add refresh token support" → Auth refresh token support
"@utils/parser.ts this is broken" → Parser bug fix
"look at @config.json" → Config review
"@App.tsx add dark mode toggle" → Dark mode toggle in App
</examples>`

/** 注入点：可覆盖的非流式 chat 函数（测试用）。 */
type ChatFn = typeof defaultChat

/** 标题生成所需的最小依赖（AgentDependencies 的结构子集）。 */
type TitleDeps = {
  db: DB
  llmRegistry: Registry
  config: Config
  /** 可选注入 chat 实现；默认走真实 llm/provider。 */
  chatFn?: ChatFn
}

/** 解析标题生成用的 (provider, model)：smol 角色优先，否则用传入的实际 chat 模型。 */
function resolveTitleModel(
  config: Config,
  chatProvider: string,
  chatModel: string,
): { provider: string; model: string } {
  const smol = config.roleRouting?.smol
  if (smol) return { provider: smol.provider, model: smol.model }
  return { provider: chatProvider, model: chatModel }
}

/**
 * 清理模型原始输出为标题：剥除 <think> 标签（推理模型可能输出），取首个非空
 * trim 行，超长截断加省略号。参考 opencode 的标题清理逻辑。
 */
function cleanTitle(raw: string): string {
  const noThink = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, '')
  const firstLine =
    noThink
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  if (firstLine.length > TITLE_MAX_LENGTH) {
    return `${firstLine.slice(0, TITLE_MAX_LENGTH - 3)}...`
  }
  return firstLine
}

/** 会话标题是否仍是默认占位值。 */
function isDefaultTitle(title: string): boolean {
  return title === DEFAULT_SESSION_TITLE
}

/**
 * 为会话生成标题并持久化。fire-and-forget 语义：任何错误都被吞掉，
 * 绝不向调用方抛出，绝不覆盖一个已存在的非默认标题。
 *
 * @param deps          最小依赖（含可注入的 chatFn）
 * @param sessionId     目标会话 id
 * @param firstMessage  第一条用户消息原文
 * @param chatProvider  会话实际使用的 LLM provider（AgentConfig.provider）
 * @param chatModel     会话实际使用的 LLM model（AgentConfig.model）
 */
async function generateSessionTitle(
  deps: TitleDeps,
  sessionId: string,
  firstMessage: string,
  chatProvider: string,
  chatModel: string,
): Promise<void> {
  const { db, llmRegistry, config, chatFn = defaultChat } = deps
  try {
    const { provider, model } = resolveTitleModel(config, chatProvider, chatModel)
    const messages: ChatMessage[] = [
      { role: 'user', content: `Generate a title for this conversation:\n${firstMessage}` },
    ]
    const request: ChatRequest = {
      model,
      messages,
      stream: true,
      system: TITLE_PROMPT,
    }
    const text = await chatFn({ registry: llmRegistry }, request, { provider, model })
    const title = cleanTitle(text)
    if (title.length === 0) return
    await updateSessionTitle(db, sessionId, title)
  } catch (e) {
    // 标题生成是尽力而为的辅助功能：失败不阻塞主对话流，但记录以便排查。
    console.warn('[title] generateSessionTitle failed:', e instanceof Error ? e.message : String(e))
  }
}

export { DEFAULT_SESSION_TITLE, generateSessionTitle, isDefaultTitle }
