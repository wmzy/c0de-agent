import { and, asc, count, eq, inArray, max } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { sessionEntries } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import type { MessageRole } from '../shared/types/base.js'
import type { Message, MessageContent } from '../shared/types/message.js'
import { touchSession } from './session.js'
import { estimateMessageTokens } from './token.js'
import type { MessageInput, SessionEntry } from './types.js'

/** Convert a Date-like DB value to epoch milliseconds. */
function toEpochMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  return new Date(value).getTime()
}

/** Convert a message-tagged row to a Message. */
function rowToMessage(row: typeof sessionEntries.$inferSelect): Message {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as MessageRole,
    content: row.content as MessageContent[],
    tokenCount: row.tokenCount ?? 0,
    createdAt: toEpochMs(row.createdAt),
  }
}

/** Convert any row to a SessionEntry (dispatch on tag). */
function rowToEntry(row: typeof sessionEntries.$inferSelect): SessionEntry {
  if (row.tag === 'message') {
    return rowToMessage(row)
  }
  const content = row.content as Record<string, unknown>
  const createdAt = toEpochMs(row.createdAt)
  switch (row.tag) {
    case 'compaction':
      return {
        _tag: 'compaction',
        id: row.id,
        sessionId: row.sessionId,
        summary: content.summary as string,
        originalEntryIds: content.originalEntryIds as string[],
        archiveId: content.archiveId as string,
        tokenCount: row.tokenCount ?? 0,
        createdAt,
      }
    case 'squash':
      return {
        _tag: 'squash',
        id: row.id,
        sessionId: row.sessionId,
        summary: content.summary as string,
        squashedEntryIds: content.squashedEntryIds as string[],
        archiveId: content.archiveId as string,
        tokenCount: row.tokenCount ?? 0,
        createdAt,
      }
    case 'branch_summary':
      return {
        _tag: 'branch_summary',
        id: row.id,
        sessionId: row.sessionId,
        summary: content.summary as string,
        sourceSessionId: content.sourceSessionId as string,
        createdAt,
      }
    case 'steering':
      return {
        _tag: 'steering',
        id: row.id,
        sessionId: row.sessionId,
        content: content.text as string,
        createdAt,
      }
    default:
      // Fallback: treat unknown tags as messages
      return rowToMessage(row)
  }
}

/** 会话内单调递增的条目时间戳（逻辑时钟）。
 *
 *  createdAt 是会话内唯一的顺序判定键（getMessages/getEntries/压缩摘要定位/
 * 工具对相邻性都按它排序），因此必须**严格递增**——并列时间戳会让顺序退化成
 * 物理行序，任何「删除+重插」都会把条目挪到时间线末尾。
 * 会话内已有条目的时间戳可能晚于当前时刻（跨机导入、时钟偏移、快照恢复），
 * 此时直接用 now() 会让新条目排到已有条目之前，故取 max(now, 会话内最大 + 1ms)。 */
async function nextEntryTimestamp(handle: DB, sessionId: string): Promise<Date> {
  const [row] = await handle.db
    .select({ latest: max(sessionEntries.createdAt) })
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, sessionId))
  const latestMs = row?.latest ? toEpochMs(row.latest) : 0
  return new Date(Math.max(Date.now(), latestMs + 1))
}

/** 摘要条目（compaction/squash）的时间戳：定位在首个被压缩消息处。
 *  并列时间戳（fork 复制、跨机导入的历史数据）下必须再早 1ms——否则摘要落到
 *  保留尾部之后，压缩语义反转（模型先看近期消息、再看「已压缩的历史」）。 */
function summaryEntryTimestamp(firstCompacted?: Message, firstKept?: Message): Date {
  if (!firstCompacted) return new Date()
  const base = firstCompacted.createdAt
  if (firstKept === undefined || firstKept.createdAt > base) return new Date(base)
  return new Date(firstKept.createdAt - 1)
}

/** Append a message to a session. Returns the stored Message with generated id/timestamp. */
async function appendMessage(handle: DB, sessionId: string, input: MessageInput): Promise<Message> {
  const tokenCount = input.tokenCount ?? estimateMessageTokens(input.content)
  const [row] = await handle.db
    .insert(sessionEntries)
    .values({
      id: generateId(),
      sessionId,
      tag: 'message',
      role: input.role,
      content: input.content,
      tokenCount,
      createdAt: await nextEntryTimestamp(handle, sessionId),
    })
    .returning()
  await touchSession(handle, sessionId)
  if (!row) throw new Error('Failed to insert message')
  return rowToMessage(row)
}

/** Get messages for a session (tag='message' only), ordered chronologically. */
async function getMessages(
  handle: DB,
  sessionId: string,
  opts?: { limit?: number; offset?: number },
): Promise<Message[]> {
  const rows = await handle.db
    .select()
    .from(sessionEntries)
    .where(and(eq(sessionEntries.sessionId, sessionId), eq(sessionEntries.tag, 'message')))
    .orderBy(asc(sessionEntries.createdAt))
    .limit(opts?.limit ?? 100_000)
    .offset(opts?.offset ?? 0)
  return rows.map(rowToMessage)
}

/**
 * 会话 steering 条目映射为 Message 形态（role='user'，内容为 steering part）。
 * 时间线渲染与消息合并使用（P0：追加指令持久化后的展示路径）；
 * 不并入 getMessages——compaction/shake/export 等仅处理真实消息的消费者不受影响。
 */
async function getSteeringAsMessages(handle: DB, sessionId: string): Promise<Message[]> {
  const rows = await handle.db
    .select()
    .from(sessionEntries)
    .where(and(eq(sessionEntries.sessionId, sessionId), eq(sessionEntries.tag, 'steering')))
    .orderBy(asc(sessionEntries.createdAt))
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    role: 'user' as const,
    content: [{ _tag: 'steering' as const, text: (row.content as { text?: string }).text ?? '' }],
    tokenCount: row.tokenCount ?? 0,
    createdAt: toEpochMs(row.createdAt),
  }))
}

/** Count messages in a session. */
async function getMessageCount(handle: DB, sessionId: string): Promise<number> {
  const [result] = await handle.db
    .select({ value: count() })
    .from(sessionEntries)
    .where(and(eq(sessionEntries.sessionId, sessionId), eq(sessionEntries.tag, 'message')))
  return result?.value ?? 0
}

/** Delete all messages after the given 0-based index (keeps 0..index inclusive). */
async function deleteMessagesAfter(
  handle: DB,
  sessionId: string,
  messageIndex: number,
): Promise<void> {
  const messages = await getMessages(handle, sessionId)
  const toDelete = messages.slice(messageIndex + 1)
  if (toDelete.length > 0) {
    await handle.db.delete(sessionEntries).where(
      inArray(
        sessionEntries.id,
        toDelete.map((m) => m.id),
      ),
    )
  }
}

/** Low-level: get ALL entries (messages + special) in chronological order. */
async function getEntries(handle: DB, sessionId: string): Promise<SessionEntry[]> {
  const rows = await handle.db
    .select()
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, sessionId))
    .orderBy(asc(sessionEntries.createdAt))
  return rows.map(rowToEntry)
}

/** Low-level: delete entries by id. */
async function deleteEntriesByIds(handle: DB, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await handle.db.delete(sessionEntries).where(inArray(sessionEntries.id, ids))
}

/** Low-level: insert a raw entry row (for compaction/squash/branch_summary/steering).
 *  未显式给 createdAt 时取会话内单调递增时间戳（追加语义：排在全部已有条目之后）。 */
async function insertEntry(
  handle: DB,
  values: typeof sessionEntries.$inferInsert,
): Promise<typeof sessionEntries.$inferSelect> {
  const rowValues =
    values.createdAt === undefined
      ? { ...values, createdAt: await nextEntryTimestamp(handle, values.sessionId) }
      : values
  const [row] = await handle.db.insert(sessionEntries).values(rowValues).returning()
  if (!row) throw new Error('Failed to insert entry')
  return row
}

/** 就地改写条目内容（shake 替换区域用）。
 *  刻意不走「删除 + 重插」：重插的行落到物理末尾，并列时间戳的会话里会把
 *  被改写消息挪到时间线最后——内容替换不应改变条目位置。 */
async function updateEntryContent(
  handle: DB,
  id: string,
  content: MessageContent[],
  tokenCount: number,
): Promise<void> {
  await handle.db
    .update(sessionEntries)
    .set({ content, tokenCount })
    .where(eq(sessionEntries.id, id))
}

export {
  appendMessage,
  deleteEntriesByIds,
  deleteMessagesAfter,
  getEntries,
  getMessageCount,
  getMessages,
  getSteeringAsMessages,
  insertEntry,
  summaryEntryTimestamp,
  updateEntryContent,
}
