import type { DB } from '../db/client.js'
import { generateId } from '../shared/index.js'
import type { Message } from '../shared/types/message.js'
import { archiveOriginalEntries } from './archive.js'
import { deleteEntriesByIds, getMessages, insertEntry } from './message.js'
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

/** Build the LLM summarization prompt for a set of messages. */
function buildCompactionPrompt(messages: Message[]): string {
  const history = messages
    .map(
      (m) =>
        `[${m.role}] ${m.content.map((p) => (p._tag === 'text' ? p.text : JSON.stringify(p))).join(' ')}`,
    )
    .join('\n')

  return `将以下对话历史压缩为结构化摘要。保留关键信息，丢弃冗余细节。

## Goal
用户的目标是什么

## Progress
已完成的工作

## Decisions
做出的关键决策

## Next Steps
接下来要做什么

## Critical Context
必须记住的上下文（文件路径、变量名、错误信息等）

## Modified Files
修改过的文件列表及变更摘要

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

  const prompt = buildCompactionPrompt(compactMessages)
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
