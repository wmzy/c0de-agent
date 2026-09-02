import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { sessionEntries, sessions } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import { getEntries, insertEntry } from './message.js'
import { createSession, getSession, rowToSession } from './session.js'
import { copyFileSnapshots } from './snapshot.js'
import type { Session, SessionEntry, SessionTreeNode } from './types.js'

/**
 * fork 分支点 messageIndex 越界（评审 NIT：客户端索引过期/分页 bug）。
 * 与「会话不存在」区分开：消费路由应映射 400 并透出 message，而非 404。
 */
class BranchPointOutOfRangeError extends Error {
  constructor(messageIndex: number) {
    super(`Branch point message index ${messageIndex} out of range`)
    this.name = 'BranchPointOutOfRangeError'
  }
}

/** 把 SessionEntry 还原为 sessionEntries 原始行（fork 复制用）。 */
function entryToRow(e: SessionEntry, sessionId: string): typeof sessionEntries.$inferInsert {
  const id = generateId()
  // Message 无 _tag（共享类型）；其余条目经 _tag 判别。
  if (!('_tag' in e)) {
    return {
      id,
      sessionId,
      tag: 'message',
      role: e.role,
      content: e.content,
      tokenCount: e.tokenCount,
    }
  }
  switch (e._tag) {
    case 'compaction':
      return {
        id,
        sessionId,
        tag: 'compaction',
        content: {
          summary: e.summary,
          originalEntryIds: e.originalEntryIds,
          archiveId: e.archiveId,
        },
        tokenCount: e.tokenCount,
      }
    case 'squash':
      return {
        id,
        sessionId,
        tag: 'squash',
        content: {
          summary: e.summary,
          squashedEntryIds: e.squashedEntryIds,
          archiveId: e.archiveId,
        },
        tokenCount: e.tokenCount,
      }
    case 'branch_summary':
      return {
        id,
        sessionId,
        tag: 'branch_summary',
        content: { summary: e.summary, sourceSessionId: e.sourceSessionId },
      }
    case 'steering':
      return { id, sessionId, tag: 'steering', content: { text: e.content } }
  }
}

/** Fork a session at a message index — copies all entries (messages + tool pairs)
 *  up to and including the branch point message, plus latest file snapshots. */
async function forkSession(handle: DB, sessionId: string, messageIndex: number): Promise<Session> {
  const source = await getSession(handle, sessionId)
  if (!source) throw new Error(`Session not found: ${sessionId}`)

  const entries = await getEntries(handle, sessionId)
  const msgEntries = entries.filter((e) => !('_tag' in e))
  const target = msgEntries[messageIndex]
  if (!target) {
    throw new BranchPointOutOfRangeError(messageIndex)
  }
  const targetIdx = entries.findIndex((e) => e.id === target.id)
  const toCopy = entries.slice(0, targetIdx + 1)

  // 多表写入（sessions insert/update + sessionEntries 复制 + 快照复制）包单个事务：
  // 中途失败整体回滚，不残留永久可见的半成品分支（同 compactSession/squashRecent 写法）。
  const updated = await handle.db.transaction(async (tx) => {
    const txHandle: DB = { db: tx, close: handle.close }

    const forked = await createSession(
      txHandle,
      `Branch of ${source.title}`,
      source.projectId ?? undefined,
    )
    await tx
      .update(sessions)
      .set({ parentId: sessionId, branchPoint: messageIndex })
      .where(eq(sessions.id, forked.id))

    for (const e of toCopy) {
      await insertEntry(txHandle, entryToRow(e, forked.id))
    }

    await insertEntry(txHandle, {
      id: generateId(),
      sessionId: forked.id,
      tag: 'branch_summary',
      content: {
        summary: `Branched from session ${sessionId} at message ${messageIndex}`,
        sourceSessionId: sessionId,
      },
    })

    // 复制源会话最新文件快照（P1-4：@文件上下文随分支保留）。
    await copyFileSnapshots(txHandle, sessionId, forked.id)

    const created = await getSession(txHandle, forked.id)
    if (!created) throw new Error('Forked session not found after creation')
    return created
  })

  return updated
}

/** Get direct child sessions (branches) of a session. */
async function getBranches(handle: DB, sessionId: string): Promise<Session[]> {
  const rows = await handle.db.select().from(sessions).where(eq(sessions.parentId, sessionId))
  return rows.map(rowToSession)
}

/** Build a full session tree from root sessions down.
 * 每层按 metadata.lastOpenedAt 降序（fallback updatedAt、createdAt）。
 */
async function getTree(handle: DB): Promise<SessionTreeNode[]> {
  const rows = await handle.db.select().from(sessions)
  const byParent = new Map<string | null, Session[]>()
  for (const row of rows) {
    const session = rowToSession(row)
    const list = byParent.get(session.parentId) ?? []
    list.push(session)
    byParent.set(session.parentId, list)
  }

  // 排序键：lastOpenedAt > updatedAt > createdAt（均为 epoch ms）
  const sortKey = (s: Session): number => s.metadata.lastOpenedAt ?? s.updatedAt ?? s.createdAt ?? 0

  const build = (parentId: string | null): SessionTreeNode[] =>
    (byParent.get(parentId) ?? [])
      .slice()
      .sort((a, b) => sortKey(b) - sortKey(a))
      .map((session) => ({
        session,
        children: build(session.id),
      }))

  return build(null)
}

export { BranchPointOutOfRangeError, forkSession, getBranches, getTree }
