import { createHash } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { fileSnapshots } from '../db/schema.js'
import { estimateTokens } from './token.js'
import type { FileSnapshot } from './types.js'

function rowToSnapshot(row: typeof fileSnapshots.$inferSelect): FileSnapshot {
  const createdAt =
    row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime()
  return {
    id: row.id,
    sessionId: row.sessionId,
    filePath: row.filePath,
    content: row.content,
    contentHash: row.contentHash,
    tokenCount: row.tokenCount ?? 0,
    version: row.version ?? 1,
    createdAt,
  }
}

/** Create or update a file snapshot. Always creates a new version. Returns the snapshot id. */
async function upsertFileSnapshot(
  handle: DB,
  sessionId: string,
  filePath: string,
  content: string,
): Promise<string> {
  const contentHash = createHash('sha256').update(content).digest('hex')
  const tokenCount = estimateTokens(content)

  const [existing] = await handle.db
    .select()
    .from(fileSnapshots)
    .where(and(eq(fileSnapshots.sessionId, sessionId), eq(fileSnapshots.filePath, filePath)))
    .orderBy(desc(fileSnapshots.version))
    .limit(1)

  const version = (existing?.version ?? 0) + 1
  const [row] = await handle.db
    .insert(fileSnapshots)
    .values({ sessionId, filePath, content, contentHash, tokenCount, version })
    .returning()
  if (!row) throw new Error('Failed to insert file snapshot')
  return row.id
}

/** Get all snapshots for a session. */
async function getFileSnapshots(handle: DB, sessionId: string): Promise<FileSnapshot[]> {
  const rows = await handle.db
    .select()
    .from(fileSnapshots)
    .where(eq(fileSnapshots.sessionId, sessionId))
  return rows.map(rowToSnapshot)
}

/** Get the latest snapshot for a specific file, or null. */
async function getLatestFileSnapshot(
  handle: DB,
  sessionId: string,
  filePath: string,
): Promise<FileSnapshot | null> {
  const [row] = await handle.db
    .select()
    .from(fileSnapshots)
    .where(and(eq(fileSnapshots.sessionId, sessionId), eq(fileSnapshots.filePath, filePath)))
    .orderBy(desc(fileSnapshots.version))
    .limit(1)
  return row ? rowToSnapshot(row) : null
}

/** Quick check: return cached file content if a snapshot exists, else null. */
async function checkFileSnapshot(
  handle: DB,
  sessionId: string,
  filePath: string,
): Promise<string | null> {
  const snapshot = await getLatestFileSnapshot(handle, sessionId, filePath)
  return snapshot?.content ?? null
}

export { checkFileSnapshot, getFileSnapshots, getLatestFileSnapshot, upsertFileSnapshot }
