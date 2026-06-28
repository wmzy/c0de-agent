import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { sessions } from '../db/schema.js'
import type { Session, SessionMetadata } from '../shared/types/message.js'

/** Convert a DB row (with Date timestamps) to the shared Session type (with number timestamps). */
export function rowToSession(row: typeof sessions.$inferSelect): Session {
  const created =
    row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime()
  const updated =
    row.updatedAt instanceof Date ? row.updatedAt.getTime() : new Date(row.updatedAt).getTime()
  return {
    id: row.id,
    title: row.title,
    parentId: row.parentId,
    projectId: row.projectId,
    branchPoint: row.branchPoint,
    metadata: (row.metadata ?? {}) as SessionMetadata,
    createdAt: created,
    updatedAt: updated,
  }
}

/** Create a new root session. */
async function createSession(handle: DB, title: string, projectId?: string): Promise<Session> {
  const [row] = await handle.db
    .insert(sessions)
    .values({ title, projectId: projectId ?? null })
    .returning()
  if (!row) throw new Error('Failed to insert session')
  return rowToSession(row)
}

/** Get a session by id, or null if not found. */
async function getSession(handle: DB, id: string): Promise<Session | null> {
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  return row ? rowToSession(row) : null
}

/** List all sessions. */
async function listSessions(handle: DB): Promise<Session[]> {
  const rows = await handle.db.select().from(sessions)
  return rows.map(rowToSession)
}

/** Delete a session (cascades to entries, archives, snapshots via FK). */
async function deleteSession(handle: DB, id: string): Promise<void> {
  await handle.db.delete(sessions).where(eq(sessions.id, id))
}

/** Update a session's title. */
async function updateSessionTitle(handle: DB, id: string, title: string): Promise<void> {
  await handle.db.update(sessions).set({ title, updatedAt: new Date() }).where(eq(sessions.id, id))
}

/** Bump updatedAt to now (used after appending messages). */
async function touchSession(handle: DB, id: string): Promise<void> {
  await handle.db.update(sessions).set({ updatedAt: new Date() }).where(eq(sessions.id, id))
}

async function listSessionsByProject(handle: DB, projectId: string): Promise<Session[]> {
  const rows = await handle.db.select().from(sessions).where(eq(sessions.projectId, projectId))
  return rows.map(rowToSession)
}

export {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  listSessionsByProject,
  touchSession,
  updateSessionTitle,
}
