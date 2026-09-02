import type { DB } from '../db/client.js'
import { generateId } from '../shared/index.js'
import type { Message, MessageContent } from '../shared/types/message.js'
import { archiveOriginalEntries } from './archive.js'
import { deleteEntriesByIds, getEntries, getMessages, insertEntry } from './message.js'
import { upsertFileSnapshot } from './snapshot.js'
import { estimateMessageTokens, estimateTokens } from './token.js'
import type { CompactionConfig, CompactionResult, HotFile, Summarizer } from './types.js'

/**
 * Find a safe cut point: the index of the most recent 'user' message
 * at or before `preferredCut`. Cutting at a user-turn boundary ensures
 * we never split an assistant reply from its tool results.
 */
function findSafeCutPoint(messages: Message[], preferredCut: number): number {
  const upper = Math.min(preferredCut, messages.length)
  for (let i = upper; i >= 0; i--) {
    const msg = messages[i]
    if (msg && msg.role === 'user') return i
  }
  return 0
}

/** Extract frequently-accessed files (read ≥ 2 times) from message history. */
function extractHotFiles(messages: Message[]): HotFile[] {
  const accessCount = new Map<string, number>()
  const callPath = new Map<string, string>()
  const latestContent = new Map<string, string>()

  for (const msg of messages) {
    for (const part of msg.content) {
      if (part._tag === 'tool_call' && part.tool === 'read') {
        const input = part.input as { path?: string }
        if (input?.path) {
          accessCount.set(input.path, (accessCount.get(input.path) ?? 0) + 1)
          callPath.set(part.id, input.path)
        }
      }
      if (part._tag === 'tool_result' && part.tool === 'read') {
        if (part.output._tag === 'success') {
          const path = callPath.get(part.id)
          if (path) latestContent.set(path, part.output.output)
        }
      }
    }
  }

  const hot: HotFile[] = []
  for (const [path, count] of accessCount) {
    if (count >= 2) {
      const content = latestContent.get(path)
      if (content) {
        hot.push({ path, content, tokenCount: estimateTokens(content), accessCount: count })
      }
    }
  }
  return hot.sort((a, b) => b.accessCount - a.accessCount).slice(0, 10)
}

/** 工具输出在压缩 prompt 中保留的最大字符数（参考 opencode）。 */
const TOOL_OUTPUT_MAX_CHARS = 2000

/** 截断超长字符串：head 60% + "[truncated]" + tail 40%，而非硬切。 */
function truncateToolOutput(s: string): string {
  if (s.length <= TOOL_OUTPUT_MAX_CHARS) return s
  const head = Math.floor(TOOL_OUTPUT_MAX_CHARS * 0.6)
  const tail = TOOL_OUTPUT_MAX_CHARS - head
  return `${s.slice(0, head)}[truncated]${s.slice(-tail)}`
}

/** 序列化单个 content part：text/thinking 保持原样，tool 输出超长时截断。 */
function serializePart(p: MessageContent): string {
  if (p._tag === 'text' || p._tag === 'thinking') return p.text
  if (p._tag === 'tool_call') {
    const input = truncateToolOutput(JSON.stringify(p.input))
    return JSON.stringify({ _tag: p._tag, id: p.id, tool: p.tool, input })
  }
  if (p._tag === 'tool_result') {
    const output = truncateToolOutput(JSON.stringify(p.output))
    return JSON.stringify({ _tag: p._tag, id: p.id, tool: p.tool, output })
  }
  return JSON.stringify(p)
}

/**
 * Build the LLM summarization prompt for a set of messages.
 *
 * 当存在 previousSummary（上一次压缩生成的摘要）时，prompt 头部改为增量更新指令，
 * 引导模型在已有摘要上叠加新事实、剔除过时信息，从而避免连续多次压缩导致的
 * 信息逐次丢失。无 previousSummary 时退回原始的从零压缩指令。
 */
function buildCompactionPrompt(messages: Message[], previousSummary?: string): string {
  const history = messages
    .map((m) => `[${m.role}] ${m.content.map((p) => serializePart(p)).join(' ')}`)
    .join('\n')

  const sections = `## Agenda
逐条列出对话中出现的议题/任务，按处理顺序排列。每条格式：
- **[议题标题]** — ✅已解决 / ⏳进行中 / 🔒阻塞 / 📋待办
  - ✅/🔒 → 一行：最终结论或卡点
  - ⏳/📋 → 完整保留：目标、约束、已尝试方向、相关文件路径、关键决策、待确认问题

## Goal
用户此次会话的总体目标（若 Agenda 已涵盖，写"见 Agenda"）

## Constraints & Preferences
用户约束、偏好、规范要求（或"(none)"）

## Key Decisions
做出的关键决策及原因

## Critical Context
必须记住的技术事实（文件路径、变量名、命令、错误信息、未解决问题）

## Modified Files
修改过的文件路径及变更摘要

## Relevant Files
对任务重要的文件/目录路径及原因`

  const header = previousSummary
    ? `更新以下已有【议题驱动】摘要。重点：
- 已解决的议题：状态更新为✅并压缩为一行结论；
- 新增议题：补入 Agenda 并完整保留其描述与约束；
- 尚未解决的议题：保持其原有描述与约束不变，只叠加本轮新进展。

<previous-summary>
${previousSummary}
</previous-summary>`
    : `将以下对话历史压缩为一份【议题驱动】的结构化摘要。
核心原则——非对称保留：已解决的议题只留一行结论；尚未解决/待办的议题
必须完整保留其描述、约束、已尝试方向、相关文件与待确认问题，它们是后续
工作的蓝图，绝不可被稀释。`

  return `${header}

${sections}

---
对话历史：
${history}`
}

/**
 * Token cost of a single message, honoring a stored tokenCount when present.
 * Mirrors core/context.ts rawMessageTokens without crossing the core→session
 * layer boundary (core already imports session, so session must not import core).
 */
function messageTokens(m: Message): number {
  if (m.tokenCount > 0) return m.tokenCount
  return estimateMessageTokens(m.content)
}

/**
 * Find the start index of the token-budgeted keep window by reverse-walking
 * from the newest message. This is the session-layer analogue of
 * core/context.ts fitToBudget's keep-window logic: accumulate tokens from the
 * end until `keepRecentTokens` is exceeded, then everything older is eligible
 * for compaction. At least the most recent message is always retained.
 */
function findKeepRecentStart(messages: Message[], keepRecentTokens: number): number {
  if (messages.length === 0) return 0
  let used = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    const tc = messageTokens(m)
    if (used + tc > keepRecentTokens) break
    used += tc
    start = i
  }
  // Always retain at least the most recent message.
  return Math.min(start, messages.length - 1)
}

/**
 * 查找 session 最新的 compaction 摘要，用于增量摘要（P0-2）。
 *
 * 从全部 entries 中筛选 tag='compaction' 的记录，取最后一条（时间序最晚）的
 * summary。无历史摘要时返回 undefined，buildCompactionPrompt 据此退回从零压缩模式。
 */
async function findPreviousSummary(handle: DB, sessionId: string): Promise<string | undefined> {
  const entries = await getEntries(handle, sessionId)
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry && '_tag' in entry && entry._tag === 'compaction') {
      return entry.summary
    }
  }
  return undefined
}

/**
 * Compact a session: summarize old messages, archive them, keep recent ones.
 *
 * The keep window is driven by a token budget (`keepRecentTokens`), not a
 * fixed message count — so compaction actually fires on a few long messages
 * instead of silently no-op'ing when message count is small. The `summarizer`
 * function is injected (the session layer never imports the LLM package).
 *
 * All destructive writes (archive + snapshot + delete + insert) run inside a
 * single transaction so a mid-way failure cannot lose history: the originals
 * are only deleted once the summary is durably stored.
 */
async function compactSession(
  handle: DB,
  sessionId: string,
  summarizer: Summarizer,
  config?: Partial<CompactionConfig>,
): Promise<CompactionResult> {
  const messages = await getMessages(handle, sessionId)
  const keepRecentTokens = config?.keepRecentTokens ?? 4000

  if (messages.length === 0) {
    return { compacted: false, reason: 'too_few_messages' }
  }

  // Reverse-walk from the newest message to find the keep window boundary,
  // driven by a token budget rather than a fixed message count.
  const keepStart = findKeepRecentStart(messages, keepRecentTokens)
  // Align the cut to a user-turn boundary so we never split an assistant
  // reply from its tool results.
  const cutPoint = findSafeCutPoint(messages, keepStart)
  const compactMessages = messages.slice(0, cutPoint)
  const keepMessages = messages.slice(cutPoint)

  if (compactMessages.length === 0) {
    return { compacted: false, reason: 'nothing_to_compact' }
  }

  // 查询当前 session 最新的 compaction 摘要，作为增量更新的基线（P0-2）。
  // 这样连续多次压缩时，新摘要会基于已有摘要叠加而非从零重建，避免早期信息逐次丢失。
  const previousSummary = await findPreviousSummary(handle, sessionId)

  const prompt = buildCompactionPrompt(compactMessages, previousSummary)
  // Run the (slow, network) summarizer OUTSIDE the transaction so we don't
  // hold a DB transaction open across an LLM call.
  const summary = await summarizer(prompt)

  const compactionEntryId = generateId()

  // Atomic rewrite: archive originals → upsert snapshots → delete originals →
  // insert summary. If any step throws, the whole transaction rolls back and
  // the original message history is left intact.
  const { archiveId, fileSnapshotIds } = await handle.db.transaction(async (tx) => {
    const txHandle: DB = { db: tx, close: handle.close }

    const archiveId = await archiveOriginalEntries(
      txHandle,
      sessionId,
      compactMessages,
      'compaction',
      summary,
      compactionEntryId,
    )

    const fileSnapshotIds: string[] = []
    if (config?.preserveSnapshots !== false) {
      const hotFiles = extractHotFiles(compactMessages)
      for (const file of hotFiles) {
        // 不传 mtimeMs：由 upsertFileSnapshot 从已有行透传，压缩后热文件不误判过期。
        const id = await upsertFileSnapshot(txHandle, sessionId, file.path, file.content)
        fileSnapshotIds.push(id)
      }
    }

    await deleteEntriesByIds(
      txHandle,
      compactMessages.map((m) => m.id),
    )

    await insertEntry(txHandle, {
      id: compactionEntryId,
      sessionId,
      tag: 'compaction',
      content: {
        summary,
        originalEntryIds: compactMessages.map((m) => m.id),
        archiveId,
      },
      tokenCount: estimateTokens(summary),
      // Position the summary at the first compacted message's timestamp so it
      // sorts BEFORE the kept recent messages under createdAt-ascending order.
      createdAt: compactMessages[0] ? new Date(compactMessages[0].createdAt) : new Date(),
    })

    return { archiveId, fileSnapshotIds }
  })

  return {
    compacted: true,
    summary,
    archiveId,
    fileSnapshots: fileSnapshotIds,
    compactedCount: compactMessages.length,
    keptCount: keepMessages.length,
  }
}

export { buildCompactionPrompt, compactSession, extractHotFiles, findSafeCutPoint }
