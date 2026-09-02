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
    ...(row.mtimeMs != null ? { mtimeMs: Number(row.mtimeMs) } : {}),
  }
}

/** Create or update a file snapshot. Always creates a new version. Returns the snapshot id.
 *  未传 mtimeMs 时从同文件已有最新行透传（而非置空）：compaction/squash 等从
 *  工具结果重建快照的调用点拿不到磁盘 mtime，透传旧值可避免每次压缩后热文件
 *  被误判过期而多一轮冗余重读（自愈无害但浪费；旧值 ≤ 内容实际新鲜度，
 *  绝不会掩盖磁盘真实变更）。 */
async function upsertFileSnapshot(
  handle: DB,
  sessionId: string,
  filePath: string,
  content: string,
  mtimeMs?: number,
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
  // mtimeMs 是浮点（stat 返回微秒精度），bigint 列不接受小数；取整存储。
  // 调用方未显式提供时继承已有行的 mtimeMs（见函数头注释）。
  const effectiveMtimeMs = mtimeMs ?? (existing?.mtimeMs != null ? Number(existing.mtimeMs) : null)
  const [row] = await handle.db
    .insert(fileSnapshots)
    .values({
      sessionId,
      filePath,
      content,
      contentHash,
      tokenCount,
      version,
      ...(effectiveMtimeMs != null ? { mtimeMs: Math.round(effectiveMtimeMs) } : {}),
    })
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

/** 把源会话每个文件的最新快照复制到目标会话（fork 分支用，P1-4）。 */
async function copyFileSnapshots(
  handle: DB,
  fromSessionId: string,
  toSessionId: string,
): Promise<void> {
  const rows = await handle.db
    .select()
    .from(fileSnapshots)
    .where(eq(fileSnapshots.sessionId, fromSessionId))
  const latest = new Map<string, typeof fileSnapshots.$inferSelect>()
  for (const r of rows) {
    const prev = latest.get(r.filePath)
    if (!prev || (r.version ?? 0) > (prev.version ?? 0)) latest.set(r.filePath, r)
  }
  for (const r of latest.values()) {
    await handle.db.insert(fileSnapshots).values({
      sessionId: toSessionId,
      entryId: r.entryId,
      filePath: r.filePath,
      content: r.content,
      contentHash: r.contentHash,
      tokenCount: r.tokenCount,
      version: r.version,
      mtimeMs: r.mtimeMs,
    })
  }
}

export {
  checkFileSnapshot,
  copyFileSnapshots,
  getFileSnapshots,
  getLatestFileSnapshot,
  upsertFileSnapshot,
}
