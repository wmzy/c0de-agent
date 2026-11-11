import { and, desc, eq, ilike } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { compactionArchives } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import { isUuid } from '../shared/utils/string.js'
import { toEpochMs } from './time.js'
import type { CompactionArchive, SessionEntry } from './types.js'

function rowToArchive(row: typeof compactionArchives.$inferSelect): CompactionArchive {
  return {
    id: row.id,
    sessionId: row.sessionId,
    compactionId: row.compactionId,
    archiveType: row.archiveType as 'compaction' | 'squash' | 'shake' | 'clear',
    originalEntries: row.originalEntries as SessionEntry[],
    summary: row.summary,
    tokenCount: row.tokenCount ?? 0,
    searchableText: row.searchableText ?? '',
    createdAt: toEpochMs(row.createdAt),
  }
}

/** Convert an entry to searchable plain text. */
function entryToSearchableText(entry: SessionEntry): string {
  if ('_tag' in entry) {
    switch (entry._tag) {
      case 'compaction':
      case 'squash':
      case 'branch_summary':
        return entry.summary
      case 'steering':
        return entry.content
    }
  }
  return entry.content
    .map((part) => {
      switch (part._tag) {
        case 'text':
        case 'thinking':
        case 'steering':
          return part.text
        case 'tool_call':
          return `${part.tool}: ${JSON.stringify(part.input ?? {})}`
        case 'tool_result':
          return JSON.stringify(part.output ?? {})
        default:
          return ''
      }
    })
    .join(' ')
}

/** Archive original entries before compaction/squash. Returns the archive id. */
async function archiveOriginalEntries(
  handle: DB,
  sessionId: string,
  entries: SessionEntry[],
  archiveType: 'compaction' | 'squash' | 'shake' | 'clear',
  summary: string,
  compactionId: string,
): Promise<string> {
  const id = generateId()
  const searchableText = entries.map(entryToSearchableText).join('\n')
  const tokenCount = entries.reduce((sum, e) => sum + ('tokenCount' in e ? e.tokenCount : 0), 0)
  await handle.db.insert(compactionArchives).values({
    id,
    sessionId,
    compactionId,
    archiveType,
    originalEntries: entries,
    summary,
    tokenCount,
    searchableText,
  })
  return id
}

/** Get an archive by id. Returns null for invalid or non-existent ids. */
async function getArchive(handle: DB, id: string): Promise<CompactionArchive | null> {
  // PGLite rejects non-UUID strings at query time; validate first.
  if (!isUuid(id)) return null
  const [row] = await handle.db
    .select()
    .from(compactionArchives)
    .where(eq(compactionArchives.id, id))
  return row ? rowToArchive(row) : null
}

/** Escape LIKE/ILIKE metacharacters so the query is treated as a literal substring. */
function escapeLikePattern(text: string): string {
  return text.replace(/[%_\\]/g, '\\$&')
}

/** Search archives by keyword (case-insensitive substring on searchable text). */
async function searchArchives(
  handle: DB,
  sessionId: string,
  query: string,
): Promise<CompactionArchive[]> {
  const pattern = `%${escapeLikePattern(query)}%`
  const rows = await handle.db
    .select()
    .from(compactionArchives)
    .where(
      and(
        eq(compactionArchives.sessionId, sessionId),
        ilike(compactionArchives.searchableText, pattern),
      ),
    )
    .orderBy(desc(compactionArchives.createdAt))
  return rows.map(rowToArchive)
}

/** List archives for a session（按创建时间倒序）。可选 query 走搜索过滤。 */
async function listArchives(
  handle: DB,
  sessionId: string,
  query?: string,
): Promise<CompactionArchive[]> {
  if (query && query.trim().length > 0) {
    return searchArchives(handle, sessionId, query.trim())
  }
  const rows = await handle.db
    .select()
    .from(compactionArchives)
    .where(eq(compactionArchives.sessionId, sessionId))
    .orderBy(desc(compactionArchives.createdAt))
  return rows.map(rowToArchive)
}

export { archiveOriginalEntries, getArchive, listArchives, searchArchives }
