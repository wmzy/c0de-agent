import { and, desc, eq, ilike } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { compactionArchives } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import type { ArchiveRef, CompactionArchive, SessionEntry } from './types.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function toEpochMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  return new Date(value).getTime()
}

function rowToArchive(row: typeof compactionArchives.$inferSelect): CompactionArchive {
  return {
    id: row.id,
    sessionId: row.sessionId,
    compactionId: row.compactionId,
    archiveType: row.archiveType as 'compaction' | 'squash',
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
          return `${part.tool}: ${JSON.stringify(part.input)}`
        case 'tool_result':
          return JSON.stringify(part.output)
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
  archiveType: 'compaction' | 'squash',
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
  if (!UUID_RE.test(id)) return null
  const [row] = await handle.db
    .select()
    .from(compactionArchives)
    .where(eq(compactionArchives.id, id))
  return row ? rowToArchive(row) : null
}

/** Get the original entries stored in an archive. */
async function getArchiveOriginalEntries(handle: DB, archiveId: string): Promise<SessionEntry[]> {
  const archive = await getArchive(handle, archiveId)
  return archive?.originalEntries ?? []
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

/** Parse a `@[archive:<id>]` or `@[squash:<n>]` reference from text. Returns null if none. */
function parseArchiveReference(text: string): ArchiveRef | null {
  const archiveId = text.match(/@\[archive:([^\]]+)\]/)?.[1]
  if (archiveId) return { type: 'archive', id: archiveId }

  const squashId = text.match(/@\[squash:(\d+|last)\]/)?.[1]
  if (squashId) return { type: 'squash', id: squashId }

  return null
}

/** Resolve an archive reference to displayable text. */
async function resolveArchiveReference(
  handle: DB,
  sessionId: string,
  ref: ArchiveRef,
): Promise<string | null> {
  if (ref.type === 'archive') {
    const archive = await getArchive(handle, ref.id)
    return archive ? `[Referenced Archive]\n${archive.summary}` : null
  }

  // squash reference: nth most recent squash archive
  const archives = await handle.db
    .select()
    .from(compactionArchives)
    .where(
      and(
        eq(compactionArchives.sessionId, sessionId),
        eq(compactionArchives.archiveType, 'squash'),
      ),
    )
    .orderBy(desc(compactionArchives.createdAt))

  const index = ref.id === 'last' ? 0 : Number.parseInt(ref.id, 10) - 1
  const row = archives[index]
  if (!row) return null
  return `[Referenced Squash #${index + 1}]\n${row.summary}`
}

export {
  archiveOriginalEntries,
  getArchive,
  getArchiveOriginalEntries,
  parseArchiveReference,
  resolveArchiveReference,
  searchArchives,
}
