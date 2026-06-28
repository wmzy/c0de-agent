import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { sessions } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import { getMessages, insertEntry } from './message.js'
import { createSession, getSession, rowToSession } from './session.js'
import type { Session, SessionTreeNode } from './types.js'

/** Fork a session at a message index — copies messages 0..index into a new child session. */
async function forkSession(handle: DB, sessionId: string, messageIndex: number): Promise<Session> {
  const source = await getSession(handle, sessionId)
  if (!source) throw new Error(`Session not found: ${sessionId}`)

  const messages = await getMessages(handle, sessionId)
  const toCopy = messages.slice(0, messageIndex + 1)

  const forked = await createSession(
    handle,
    `Branch of ${source.title}`,
    source.projectId ?? undefined,
  )
  await handle.db
    .update(sessions)
    .set({ parentId: sessionId, branchPoint: messageIndex })
    .where(eq(sessions.id, forked.id))

  for (const msg of toCopy) {
    await insertEntry(handle, {
      id: generateId(),
      sessionId: forked.id,
      tag: 'message',
      role: msg.role,
      content: msg.content,
      tokenCount: msg.tokenCount,
    })
  }

  await insertEntry(handle, {
    id: generateId(),
    sessionId: forked.id,
    tag: 'branch_summary',
    content: {
      summary: `Branched from session ${sessionId} at message ${messageIndex}`,
      sourceSessionId: sessionId,
    },
  })

  const updated = await getSession(handle, forked.id)
  if (!updated) throw new Error('Forked session not found after creation')
  return updated
}

/** Get direct child sessions (branches) of a session. */
async function getBranches(handle: DB, sessionId: string): Promise<Session[]> {
  const rows = await handle.db.select().from(sessions).where(eq(sessions.parentId, sessionId))
  return rows.map(rowToSession)
}

/** Build a full session tree from root sessions down. */
async function getTree(handle: DB): Promise<SessionTreeNode[]> {
  const rows = await handle.db.select().from(sessions)
  const byParent = new Map<string | null, Session[]>()
  for (const row of rows) {
    const session = rowToSession(row)
    const list = byParent.get(session.parentId) ?? []
    list.push(session)
    byParent.set(session.parentId, list)
  }

  const build = (parentId: string | null): SessionTreeNode[] =>
    (byParent.get(parentId) ?? []).map((session) => ({
      session,
      children: build(session.id),
    }))

  return build(null)
}

export { forkSession, getBranches, getTree }
