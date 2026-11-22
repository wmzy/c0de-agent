// agent:// URL 解析器：读取（子）agent 会话的产出（omp internal-urls/agent-protocol 移植）。
//
// omp 的 agent:// 走「artifacts 目录的 <id>.md 产物文件 + .json sidecar」；c0de 没有
// 产物文件——子 agent 的一切都持久化在 PGLite 会话里：
//   - 结构化产出 = 会话消息中 yield 工具的 tool_call/tool_result 消息对
//     （tool_call.input.data 是结构化 payload 本体；tool_result._tag='success'
//     表示该次 yield 被宿主接受——outputSchema 校验失败的 yield 折成 error result，
//     不算产出）。runSubAgent 的收集数组只在内存里，DB 侧唯一可信来源就是这对消息。
//   - 文本产出 = 最新一条有文本的 assistant 消息（omp lastAssistantText 同口径）。
//   - 运行状态 = sessions.metadata.lastRun.status（后台任务有 running/completed 标记；
//     前台子 run 不落 lastRun，视为未知——视图按「已持久化的消息」呈现，天然是进度视图）。
//
// URL 文法与 omp 对齐：
//   agent://<sessionId>              全量产出视图（yield data JSON 分节 + 最新 assistant 文本）
//   agent://<sessionId>/<json-path>  从结构化产出逐段取值：对象按键、数组按数字下标
//                                    （omp extractJsonPath 语义）；miss 报 absent 错误；
//                                    字符串值直接作正文返回，其余 JSON.stringify(,2)
// 会话不存在时，以调用方在会话树中的位置近似「同父兄弟」，fuzzy 建议最多 5 个候选。
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { DB } from '../../db/client.js'
import { sessions } from '../../db/schema.js'
import { getMessages } from '../../session/message.js'
import type { Message, SessionMetadata } from '../../shared/types/message.js'
import type { URLResolveContext, URLResolver } from '../../shared/types/tool.js'
import { isUuid } from '../../shared/utils/string.js'

/** agent 会话行的最小读取面（只取渲染要用的列）。 */
type AgentSessionRow = {
  id: string
  title: string
  parentId: string | null
  agentType: string | null
  metadata: unknown
}

/** 会话消息读取函数（默认 getMessages；测试/宿主可注入替代源）。 */
type AgentMessagesFn = (sessionId: string) => Promise<Message[]>

type AgentResolverOpts = {
  db: DB
  /** 消息读取注入点；缺省用 session/message.getMessages（tag='message' 全量）。 */
  getAgentMessages?: AgentMessagesFn
}

/** not-found 错误的候选上限（omp 口径：再多只是噪音）。 */
const MAX_ID_SUGGESTIONS = 5

/** 从 `scheme://rest` 中取出 rest（scheme 已由 resolveURL 校验，直接切首个 `://`）。 */
function stripScheme(url: string): string {
  const idx = url.indexOf('://')
  return idx < 0 ? url : url.slice(idx + 3)
}

/** 容错 URL 解码：坏转义序列原样返回（json-path 键名可能含 % 字面量）。 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** 把 `agent://<sessionId>/<json-path>` 拆成 id 与路径段（空段丢弃，容忍尾斜杠）。 */
function parseAgentUrl(url: string): { sessionId: string; segments: string[] } {
  const parts = stripScheme(url).split('/').map(decodeSegment)
  const [sessionId = '', ...rest] = parts
  return { sessionId, segments: rest.filter((s) => s.length > 0) }
}

/**
 * 逐段下钻 JSON 值（omp extractJsonPath 原语义）：对象按键取值、数组按纯数字
 * 段取下标；任一段 miss（含对 null/原始值继续下钻）返回 undefined。
 */
function extractJsonPath(data: unknown, segments: string[]): unknown {
  let current: unknown = data
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined
    if (Array.isArray(current)) {
      current = /^\d+$/.test(segment) ? current[Number(segment)] : undefined
      continue
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** 一次被接受的 yield：labels 来自 tool_call 的可选 type 字段。 */
type YieldSection = {
  labels?: string
  data: unknown
}

/**
 * 按时间线扫描消息，恢复被接受的 yield 结构化产出。tool_call 在 assistant 消息、
 * tool_result 在 tool 消息，单趟先记 call 后配对 result（时间上 result 恒晚于 call，
 * 同趟即可配对）。error result / input 无 data 的跳过——它们不是产出。
 */
function yieldSections(messages: readonly Message[]): YieldSection[] {
  const callsById = new Map<string, { data?: unknown; type?: unknown }>()
  const sections: YieldSection[] = []
  for (const message of messages) {
    for (const part of message.content) {
      if (part._tag === 'tool_call' && part.tool === 'yield') {
        const input = part.input as { data?: unknown; type?: unknown } | undefined
        if (input && typeof input === 'object') callsById.set(part.id, input)
        continue
      }
      if (part._tag !== 'tool_result' || part.tool !== 'yield') continue
      if (part.output._tag !== 'success') continue
      const input = callsById.get(part.id)
      if (!input || input.data === undefined) continue
      const type = input.type
      const labels = Array.isArray(type)
        ? type.join(', ')
        : typeof type === 'string' && type
          ? type
          : undefined
      sections.push({ ...(labels ? { labels } : {}), data: input.data })
    }
  }
  return sections
}

/** 最新一条有非空文本的 assistant 消息文本（跨 part 拼接，omp 同口径）。 */
function lastAssistantText(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    const text = message.content
      .flatMap((part) => (part._tag === 'text' ? [part.text] : []))
      .join('\n')
      .trim()
    if (text) return text
  }
  return undefined
}

/** 安全美化：循环引用等 stringify 失败时退化为 String()。 */
function jsonPretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null'
  } catch {
    return String(value)
  }
}

/** 按会话 id 查 agent 会话行；非 uuid 输入直接按不存在处理（uuid 列查询会抛 SQL 错）。 */
async function findAgentSession(db: DB, id: string): Promise<AgentSessionRow | null> {
  if (!isUuid(id)) return null
  const [row] = await db.db
    .select({
      id: sessions.id,
      title: sessions.title,
      parentId: sessions.parentId,
      agentType: sessions.agentType,
      metadata: sessions.metadata,
    })
    .from(sessions)
    .where(eq(sessions.id, id))
  return row ?? null
}

/**
 * 「同父兄弟」候选 id：目标会话不存在，其父无从得知，只能以调用方在会话树中的
 * 位置近似——caller 的子会话（caller 是父 agent 引用自己的子 agent）+ caller 的
 * 兄弟会话（caller 是子 agent 引用兄弟）。回收站会话排除。
 */
async function siblingSessionIds(db: DB, ctx: URLResolveContext): Promise<string[]> {
  const callerId = ctx.session.id
  if (!isUuid(callerId)) return []
  const [caller] = await db.db
    .select({ parentId: sessions.parentId })
    .from(sessions)
    .where(eq(sessions.id, callerId))
  const parentIds = [callerId, caller?.parentId ?? null].filter(
    (v): v is string => typeof v === 'string' && isUuid(v),
  )
  if (parentIds.length === 0) return []
  const rows = await db.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(inArray(sessions.parentId, parentIds), isNull(sessions.deletedAt)))
  return rows.map((r) => r.id)
}

/**
 * 模糊评分（-1 = 淘汰）：精确 > 前缀 > 子串 > 子序列；长度差作次级惩罚。
 * 会话 id 是 uuid：typo（换/漏/多一个字符）或截断粘贴（前缀/子串）都能召回，
 * 无需外部 fuzzy 依赖。
 */
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (q === t) return Number.MAX_SAFE_INTEGER
  if (t.startsWith(q)) return 1000 - (t.length - q.length)
  const substringAt = t.indexOf(q)
  if (substringAt >= 0) return 500 - substringAt - (t.length - q.length) * 0.1
  let cursor = 0
  let contiguous = 0
  let maxContiguous = 0
  for (const ch of q) {
    const found = t.indexOf(ch, cursor)
    if (found < 0) return -1
    contiguous = found === cursor ? contiguous + 1 : 0
    maxContiguous = Math.max(maxContiguous, contiguous)
    cursor = found + 1
  }
  return maxContiguous * 10 - (t.length - q.length)
}

/** 目标不存在时的错误：fuzzy 候选建议（≤5）；无候选则提示 id 的可信来源。 */
async function notFoundError(db: DB, sessionId: string, ctx: URLResolveContext): Promise<Error> {
  const siblings = await siblingSessionIds(db, ctx)
  const suggestions = siblings
    .filter((id) => id !== sessionId)
    .map((id) => ({ id, score: fuzzyScore(sessionId, id) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ID_SUGGESTIONS)
    .map((s) => `agent://${s.id}`)
  const hint =
    suggestions.length > 0
      ? `Did you mean: ${suggestions.join(', ')}`
      : 'Tip: the session id comes from the task tool result (sessionId field of a completed sub-agent run).'
  return new Error(`agent session not found: ${sessionId}\n${hint}`)
}

/** 全量产出视图：会话元信息 + yield 分节 JSON + 最新 assistant 文本。 */
function renderFullView(
  row: AgentSessionRow,
  sections: readonly YieldSection[],
  lastText: string | undefined,
  messageCount: number,
): string {
  const meta = (row.metadata ?? {}) as Partial<SessionMetadata>
  const status = meta.lastRun?.status ?? 'unknown'
  const lines: string[] = [
    `# Agent session: ${row.title}`,
    '',
    `- Session: ${row.id}`,
    `- Agent type: ${row.agentType ?? 'main'}`,
    `- Run status: ${status}`,
  ]
  if (sections.length > 0) {
    lines.push(
      '',
      `## Yield output (${sections.length} section${sections.length === 1 ? '' : 's'})`,
    )
    for (const [i, section] of sections.entries()) {
      lines.push(
        '',
        `### ${section.labels ? section.labels : `section ${i + 1}`}`,
        '',
        '```json',
        jsonPretty(section.data),
        '```',
      )
    }
  }
  if (lastText !== undefined) {
    lines.push('', '## Last assistant message', '', lastText)
  }
  if (sections.length === 0 && lastText === undefined) {
    // omp 的 progress 视图对应形态：无产物时如实呈现进度而非报错（运行中的子
    // agent 会话消息持续落库，这里读到的就是实时进度）。
    lines.push(
      '',
      `No output yet (${messageCount} message(s) persisted so far; the agent may still be running).`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * 路径提取视图：单次 yield 直接取其 data；多次 yield（增量分段）以数组承载，
 * 下标 0 起取段——与 omp「产物 JSON + /段」语义一致。
 */
function renderPathExtraction(
  sessionId: string,
  segments: string[],
  sections: readonly YieldSection[],
): string {
  if (sections.length === 0) {
    throw new Error(
      `agent://${sessionId}/${segments.join('/')}: no accepted yield output to extract from. Read agent://${sessionId} for the session view.`,
    )
  }
  const only = sections.length === 1 ? sections[0] : undefined
  const root = only ? only.data : sections.map((s) => s.data)
  const extracted = extractJsonPath(root, segments)
  if (extracted === undefined) {
    throw new Error(
      `agent://${sessionId}/${segments.join('/')}: JSON path not found (absent) in the yield output. Read agent://${sessionId} for the full payload.`,
    )
  }
  // 字符串字段（如报告正文）按正文读，不做 JSON 转义——omp 同口径。
  if (typeof extracted === 'string') return extracted
  return jsonPretty(extracted)
}

/** agent:// 解析器工厂。DB 经闭包注入（shared URLResolver 契约不携带重依赖）。 */
function createAgentResolver(opts: AgentResolverOpts): URLResolver {
  const readMessages: AgentMessagesFn =
    opts.getAgentMessages ?? ((sessionId) => getMessages(opts.db, sessionId))
  return {
    scheme: 'agent',
    resolve: async (url, ctx) => {
      const { sessionId, segments } = parseAgentUrl(url)
      if (!sessionId) {
        throw new Error('agent:// URL requires a session id: agent://<sessionId>[/<json-path>]')
      }
      const row = await findAgentSession(opts.db, sessionId)
      if (!row) throw await notFoundError(opts.db, sessionId, ctx)
      const messages = await readMessages(sessionId)
      const sections = yieldSections(messages)
      if (segments.length === 0) {
        return renderFullView(row, sections, lastAssistantText(messages), messages.length)
      }
      return renderPathExtraction(sessionId, segments, sections)
    },
  }
}

export { createAgentResolver, decodeSegment, stripScheme }
