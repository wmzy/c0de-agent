import { and, asc, count, eq, inArray } from 'drizzle-orm'
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

/** Low-level: insert a raw entry row (for compaction/squash/branch_summary/steering). */
async function insertEntry(
  handle: DB,
  values: typeof sessionEntries.$inferInsert,
): Promise<typeof sessionEntries.$inferSelect> {
  const [row] = await handle.db.insert(sessionEntries).values(values).returning()
  if (!row) throw new Error('Failed to insert entry')
  return row
}

export {
  appendMessage,
  deleteEntriesByIds,
  deleteMessagesAfter,
  getEntries,
  getMessageCount,
  getMessages,
  insertEntry,
}
