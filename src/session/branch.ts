import { and, eq, isNull, lte } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { compactionArchives, type sessionEntries, sessions } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import type { LLMSegment } from '../shared/types/agent.js'
import { getEntries, insertEntry } from './message.js'
import { createSession, getSession, rowToSession, webVisibleSessionCondition } from './session.js'
import { copyFileSnapshots } from './snapshot.js'
import type { Session, SessionEntry, SessionTreeNode, SessionUsage } from './types.js'

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

    const branchPointMs =
      typeof target.createdAt === 'number' ? target.createdAt : new Date(target.createdAt).getTime()

    const forked = await createSession(
      txHandle,
      `Branch of ${source.title}`,
      source.projectId ?? undefined,
      undefined,
      source.source === 'cli' ? 'cli' : 'web',
    )
    await tx
      .update(sessions)
      .set({ parentId: sessionId, branchPoint: messageIndex })
      .where(eq(sessions.id, forked.id))

    // P2：复制分支点之前的归档（compaction/squash/shake/clear 原始内容）——
    // 此前 fork 后归档面板为空、时间线压缩条目引用悬空 archiveId。
    // 新归档换新 id，并重映射复制条目中的 archiveId 引用。
    const sourceArchives = await tx
      .select()
      .from(compactionArchives)
      .where(
        and(
          eq(compactionArchives.sessionId, sessionId),
          lte(compactionArchives.createdAt, new Date(branchPointMs)),
        ),
      )
    const archiveIdMap = new Map<string, string>()
    for (const a of sourceArchives) {
      const newId = generateId()
      archiveIdMap.set(a.id, newId)
      await tx.insert(compactionArchives).values({
        id: newId,
        sessionId: forked.id,
        compactionId: a.compactionId,
        archiveType: a.archiveType,
        originalEntries: a.originalEntries,
        fileSnapshots: a.fileSnapshots,
        summary: a.summary,
        tokenCount: a.tokenCount,
        searchableText: a.searchableText,
        createdAt: a.createdAt,
      })
    }

    // P2：继承分支点之前的用量 segments（徽标/会话信息面板显示继承成本；
    // calls 按时间过滤，分支点之后的调用不属于本分支）。usage_events 账本不受影响——
    // fork 不产生新调用，backfill 经 callId 唯一约束去重，无重复记账。
    const inheritedSegments = ((source.metadata as { segments?: LLMSegment[] }).segments ?? [])
      .map((seg) => ({
        ...seg,
        calls: seg.calls.filter((c) => c.timestamp <= branchPointMs),
      }))
      .filter((seg) => seg.calls.length > 0)
    if (inheritedSegments.length > 0) {
      await tx
        .update(sessions)
        .set({ metadata: { segments: inheritedSegments } })
        .where(eq(sessions.id, forked.id))
    }

    for (const e of toCopy) {
      const row = entryToRow(e, forked.id)
      // 归档 id 重映射：compaction/squash 条目引用新复制的归档
      if (row.tag === 'compaction' || row.tag === 'squash') {
        const content = row.content as { archiveId?: unknown }
        if (typeof content.archiveId === 'string' && archiveIdMap.has(content.archiveId)) {
          row.content = { ...content, archiveId: archiveIdMap.get(content.archiveId) }
        }
      }
      await insertEntry(txHandle, row)
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

    // 复制源会话文件快照（P1-4：@文件上下文随分支保留）。
    // C3：按分支点时间过滤——分支点之后更新的快照是「未来」状态，不复制。
    await copyFileSnapshots(txHandle, sessionId, forked.id, branchPointMs)

    const created = await getSession(txHandle, forked.id)
    if (!created) throw new Error('Forked session not found after creation')
    return created
  })

  return updated
}

/** Get direct child sessions (branches) of a session. */
async function getBranches(handle: DB, sessionId: string): Promise<Session[]> {
  const rows = await handle.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.parentId, sessionId), isNull(sessions.deletedAt)))
  return rows.map(rowToSession)
}

/** 从会话 metadata.segments 聚合用量（零额外查询——段数据已在行内）。 */
function sessionUsage(session: Session): SessionUsage {
  const calls = (session.metadata.segments ?? []).flatMap((s) => s.calls ?? [])
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let cost = 0
  let unknownCostCalls = 0
  for (const c of calls) {
    inputTokens += c.usage.input
    outputTokens += c.usage.output
    cacheRead += c.usage.cacheRead ?? 0
    if (c.cost == null) {
      unknownCostCalls += 1
    } else {
      cost += c.cost
    }
  }
  return { inputTokens, outputTokens, cacheRead, cost, unknownCostCalls, calls: calls.length }
}

/** Build a full session tree from root sessions down.
 * 每层按 metadata.lastOpenedAt 降序（fallback updatedAt、createdAt）。
 * 排除软删除会话与临时 CLI 会话（print/workflow）；持久化 CLI 会话（--continue 续接）
 * 与 Web 会话同树可见（CLI/Web 同库不同视图 → 同库同视图）。
 */
async function getTree(handle: DB): Promise<SessionTreeNode[]> {
  const rows = await handle.db
    .select()
    .from(sessions)
    .where(and(isNull(sessions.deletedAt), webVisibleSessionCondition()))
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
        usage: sessionUsage(session),
      }))

  return build(null)
}

export { BranchPointOutOfRangeError, forkSession, getBranches, getTree }
