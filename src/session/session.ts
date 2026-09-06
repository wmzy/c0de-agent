import { and, eq, gt, ilike, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { sessionEntries, sessions } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import type { LLMSegment } from '../shared/types/agent.js'
import type { ChatTool } from '../shared/types/llm.js'
import type { LastRun, Session, SessionMetadata } from '../shared/types/message.js'

/** Convert a DB row (with Date timestamps) to the shared Session type (with number timestamps). */
export function rowToSession(row: typeof sessions.$inferSelect): Session {
  const created =
    row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime()
  const updated =
    row.updatedAt instanceof Date ? row.updatedAt.getTime() : new Date(row.updatedAt).getTime()
  const deleted = row.deletedAt
    ? row.deletedAt instanceof Date
      ? row.deletedAt.getTime()
      : new Date(row.deletedAt).getTime()
    : null
  return {
    id: row.id,
    title: row.title,
    parentId: row.parentId,
    projectId: row.projectId,
    branchPoint: row.branchPoint,
    metadata: (row.metadata ?? {}) as SessionMetadata,
    agentType: row.agentType ?? null,
    worktreePath: row.worktreePath ?? null,
    source: row.source === 'web' || row.source === 'cli' ? row.source : null,
    deletedAt: deleted,
    createdAt: created,
    updatedAt: updated,
  }
}

/** Create a new root session. */
async function createSession(
  handle: DB,
  title: string,
  projectId?: string,
  agentType?: string,
  source?: 'web' | 'cli',
  /** P1 会话树治理：子 agent 会话挂到父会话（树内嵌套 + 删除级联）。 */
  parentId?: string,
): Promise<Session> {
  const [row] = await handle.db
    .insert(sessions)
    .values({
      title,
      projectId: projectId ?? null,
      agentType: agentType ?? null,
      source: source ?? null,
      parentId: parentId ?? null,
    })
    .returning()
  if (!row) throw new Error('Failed to insert session')
  return rowToSession(row)
}

/** Get a session by id, or null if not found. */
async function getSession(handle: DB, id: string): Promise<Session | null> {
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  return row ? rowToSession(row) : null
}

/** List all active sessions (未软删除、非 CLI 来源；source 为 NULL 的旧数据视为 web). */
async function listSessions(handle: DB): Promise<Session[]> {
  const rows = await handle.db
    .select()
    .from(sessions)
    .where(and(isNull(sessions.deletedAt), or(isNull(sessions.source), ne(sessions.source, 'cli'))))
  return rows.map(rowToSession)
}

/** 列出所有未软删除会话（含 CLI 来源；供 ACP/CLI 等非 Web 消费者使用）。 */
async function listAllSessions(handle: DB): Promise<Session[]> {
  const rows = await handle.db.select().from(sessions).where(isNull(sessions.deletedAt))
  return rows.map(rowToSession)
}

/** List soft-deleted sessions (回收站)；projectId 提供时仅列出归属该项目的会话
 *  （P1-7：回收站此前全库共享，项目 A 的界面能清空项目 B 的删除会话）。 */
async function listDeletedSessions(handle: DB, projectId?: string): Promise<Session[]> {
  const rows = await handle.db
    .select()
    .from(sessions)
    .where(
      projectId
        ? and(gt(sessions.deletedAt, new Date(0)), eq(sessions.projectId, projectId))
        : gt(sessions.deletedAt, new Date(0)),
    )
  return rows.map(rowToSession)
}

/**
 * 软删除会话（级联其所有 fork 后代）。设置 deletedAt = now；
 * 30 天后由 purgeDeletedSessions 物理清除。
 * 会话不存在或已在回收站 → 返回 false（调用方按 404 处理）。
 */
async function softDeleteSession(handle: DB, id: string): Promise<boolean> {
  const [row] = await handle.db
    .select({ id: sessions.id, deletedAt: sessions.deletedAt })
    .from(sessions)
    .where(eq(sessions.id, id))
  if (!row || row.deletedAt) return false
  const ids = new Set<string>([id])
  let frontier = [id]
  while (frontier.length > 0) {
    // 用 parentId 过滤：收集下一层子会话
    const children = await handle.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(isNull(sessions.deletedAt), inArray(sessions.parentId, frontier)))
    frontier = children.map((r) => r.id).filter((cid) => !ids.has(cid))
    for (const r of children) ids.add(r.id)
  }
  const now = new Date()
  for (const sid of ids) {
    await handle.db.update(sessions).set({ deletedAt: now }).where(eq(sessions.id, sid))
  }
  return true
}

/**
 * 把会话归属到指定项目（P1-2 孤儿会话补救）：设置 projectId 与 worktreePath。
 * 会话不存在返回 false。
 */
async function rebindSession(
  handle: DB,
  id: string,
  project: { id: string; worktree: string },
): Promise<boolean> {
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  if (!row) return false
  await handle.db
    .update(sessions)
    .set({ projectId: project.id, worktreePath: project.worktree })
    .where(eq(sessions.id, id))
  return true
}

/**
 * 从回收站恢复会话：默认连带恢复其已软删除的祖先链——
 * 否则恢复的会话因父仍在回收站而游离于会话树之外（P2-1：UI 不可达）。
 * 祖先中未删除的（活跃）节点不需要也不应该被改动。
 */
async function restoreSession(handle: DB, id: string): Promise<boolean> {
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  if (!row?.deletedAt) return false
  const ids = new Set<string>([id])
  let parentId = row.parentId
  while (parentId) {
    const [parent] = await handle.db.select().from(sessions).where(eq(sessions.id, parentId))
    if (!parent) break
    if (parent.deletedAt) ids.add(parent.id)
    parentId = parent.parentId
  }
  for (const sid of ids) {
    await handle.db.update(sessions).set({ deletedAt: null }).where(eq(sessions.id, sid))
  }
  return true
}

/**
 * 物理清除回收站中超过保留期（默认 30 天）的会话。
 * 子会话先于父会话删除（自引用 FK 要求）。
 * 返回清除数量。启动时与每日定时调用。
 */
async function purgeDeletedSessions(
  handle: DB,
  retentionMs = 30 * 24 * 60 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionMs)
  const rows = await handle.db
    .select({ id: sessions.id, parentId: sessions.parentId })
    .from(sessions)
    .where(lt(sessions.deletedAt, cutoff))
  if (rows.length === 0) return 0
  // 拓扑序：无子会话的先删
  const remaining = new Set(rows.map((r) => r.id))
  let deleted = 0
  while (remaining.size > 0) {
    const hasChildParent = new Set(
      rows.filter((r) => r.parentId && remaining.has(r.parentId)).map((r) => r.parentId),
    )
    const leaves = rows
      .filter((r) => remaining.has(r.id) && !hasChildParent.has(r.id))
      .map((r) => r.id)
    if (leaves.length === 0) {
      // 循环引用兜底：强制按 id 逐个删除（自引用环数据异常场景）
      for (const id of Array.from(remaining)) {
        await handle.db.delete(sessions).where(eq(sessions.id, id))
        remaining.delete(id)
        deleted += 1
      }
      break
    }
    for (const id of leaves) {
      await handle.db.delete(sessions).where(eq(sessions.id, id))
      remaining.delete(id)
      deleted += 1
    }
  }
  return deleted
}

/** Update a session's title. */
async function updateSessionTitle(handle: DB, id: string, title: string): Promise<void> {
  await handle.db.update(sessions).set({ title, updatedAt: new Date() }).where(eq(sessions.id, id))
}

/**
 * 彻底删除某个回收站会话及其全部后代（含未软删除的 fork 后代，防御数据异常）。
 * 子会话先于父会话删除（自引用 FK RESTRICT 要求）；entries/archives 经 FK cascade 清理。
 * 返回删除数量。会话不存在或不在回收站 → 返回 0。
 */
async function permanentlyDeleteSession(handle: DB, id: string): Promise<number> {
  const [row] = await handle.db
    .select({ id: sessions.id, deletedAt: sessions.deletedAt })
    .from(sessions)
    .where(eq(sessions.id, id))
  if (!row?.deletedAt) return 0
  const all = await handle.db
    .select({ id: sessions.id, parentId: sessions.parentId })
    .from(sessions)
  const ids = new Set<string>([id])
  let frontier = [id]
  while (frontier.length > 0) {
    const children = all
      .filter((r) => r.parentId && frontier.includes(r.parentId))
      .map((r) => r.id)
      .filter((cid) => !ids.has(cid))
    for (const cid of children) ids.add(cid)
    frontier = children
  }
  // 拓扑序：无子会话的先删（与 purgeDeletedSessions 同策略）
  const remaining = new Set(ids)
  let deleted = 0
  while (remaining.size > 0) {
    const hasChildParent = new Set(
      Array.from(remaining).filter((rid) => {
        const r = all.find((x) => x.id === rid)
        return r?.parentId && remaining.has(r.parentId)
      }),
    )
    const leaves = Array.from(remaining).filter((rid) => !hasChildParent.has(rid))
    if (leaves.length === 0) {
      for (const rid of Array.from(remaining)) {
        await handle.db.delete(sessions).where(eq(sessions.id, rid))
        remaining.delete(rid)
        deleted += 1
      }
      break
    }
    for (const rid of leaves) {
      await handle.db.delete(sessions).where(eq(sessions.id, rid))
      remaining.delete(rid)
      deleted += 1
    }
  }
  return deleted
}

/** 清空回收站：物理删除所有已软删除会话（子先于父）。返回删除数量。
 *  projectId 提供时仅清空该项目（P1-7）。 */
async function emptyTrash(handle: DB, projectId?: string): Promise<number> {
  const rows = await handle.db
    .select({ id: sessions.id, parentId: sessions.parentId })
    .from(sessions)
    .where(
      projectId
        ? and(gt(sessions.deletedAt, new Date(0)), eq(sessions.projectId, projectId))
        : gt(sessions.deletedAt, new Date(0)),
    )
  if (rows.length === 0) return 0
  const remaining = new Set(rows.map((r) => r.id))
  let deleted = 0
  while (remaining.size > 0) {
    const hasChildParent = new Set(
      rows.filter((r) => r.parentId && remaining.has(r.parentId)).map((r) => r.parentId),
    )
    const leaves = rows
      .filter((r) => remaining.has(r.id) && !hasChildParent.has(r.id))
      .map((r) => r.id)
    if (leaves.length === 0) {
      for (const id of Array.from(remaining)) {
        await handle.db.delete(sessions).where(eq(sessions.id, id))
        remaining.delete(id)
        deleted += 1
      }
      break
    }
    for (const id of leaves) {
      await handle.db.delete(sessions).where(eq(sessions.id, id))
      remaining.delete(id)
      deleted += 1
    }
  }
  return deleted
}

/**
 * 清理过期临时会话（P2 → P1 收紧：仅清理显式标记的临时会话）。
 * - agentType='print'：CLI 一次性问答（c0de chat，非 --continue）创建的会话。
 * - agentType='workflow'：工作流运行产生的会话。
 * 普通 CLI 会话（ACP）与 --continue 续接的会话（续接时已升级）永不清理——
 * 此前按 source='cli' 全删会把用户显式续接的历史静默物理删除。
 * 保留期默认 30 天；子条目经 FK cascade 一并删除。
 * 返回清除数量。启动时与每日定时调用。
 */
async function purgeTemporarySessions(
  handle: DB,
  retentionMs = 30 * 24 * 60 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionMs)
  const rows = await handle.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        lt(sessions.updatedAt, cutoff),
        or(eq(sessions.agentType, 'print'), eq(sessions.agentType, 'workflow')),
      ),
    )
  for (const row of rows) {
    await handle.db.delete(sessions).where(eq(sessions.id, row.id))
  }
  return rows.length
}

/**
 * 把临时会话升级为持久会话（--continue 续接时调用）：
 * 清除 print 标记，30 天临时清理不再触及。
 */
async function upgradeTemporarySession(handle: DB, id: string): Promise<void> {
  await handle.db.update(sessions).set({ agentType: null }).where(eq(sessions.id, id))
}

/** Bump updatedAt to now (used after appending messages). */
async function touchSession(handle: DB, id: string): Promise<void> {
  await handle.db.update(sessions).set({ updatedAt: new Date() }).where(eq(sessions.id, id))
}

/** 记录会话上次打开时间（用于会话列表按最近打开排序）。 */
async function touchLastOpened(handle: DB, id: string): Promise<void> {
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  if (!row) return
  const meta = (row.metadata ?? {}) as SessionMetadata
  await handle.db
    .update(sessions)
    .set({ metadata: { ...meta, lastOpenedAt: Date.now() } })
    .where(eq(sessions.id, id))
}

/** 规格化工具集并计算前缀指纹。tools 顺序不影响指纹（按 name 排序）。 */
export function segmentFingerprint(systemPrompt: string, tools: ChatTool[]): string {
  const norm = JSON.stringify({
    systemPrompt,
    tools: [...tools]
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  })
  let h = 5381
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

/**
 * 将旧 metadata.llmDetails 迁移为单个 legacy segment。
 * - 无 llmDetails 或已有 segments → 原样返回。
 * - 否则取首条的 systemPrompt/tools 作为段首快照，所有旧 detail 转为 calls，
 *   responseText 从 responseChunks 的 text 块拼接提取。
 * 幂等：迁移后 llmDetails 字段被移除，不会重复迁移。
 */
export function migrateLegacyDetails(meta: Record<string, unknown>): Record<string, unknown> {
  if (meta.segments !== undefined) return meta
  const legacy = meta.llmDetails
  if (!Array.isArray(legacy) || legacy.length === 0) return meta
  const first = legacy[0] as {
    systemPrompt: string
    tools: ChatTool[]
    provider: string
    model: string
    contextWindow?: number
    timestamp: number
  }
  const segment: LLMSegment = {
    id: generateId(),
    fingerprint: segmentFingerprint(first.systemPrompt, first.tools ?? []),
    provider: first.provider,
    model: first.model,
    systemPrompt: first.systemPrompt,
    tools: first.tools ?? [],
    startedAt: first.timestamp,
    trigger: 'initial',
    ...(first.contextWindow !== undefined ? { contextWindow: first.contextWindow } : {}),
    calls: legacy.map((d) => {
      const detail = d as {
        id: string
        timestamp: number
        usage: LLMSegment['calls'][number]['usage']
        latency: LLMSegment['calls'][number]['latency']
        cost: number
        thinking?: string
        responseChunks: Array<{ _tag: string; text?: string }>
      }
      return {
        id: detail.id,
        timestamp: detail.timestamp,
        usage: detail.usage,
        latency: detail.latency,
        cost: detail.cost,
        ...(detail.thinking ? { thinking: detail.thinking } : {}),
        responseText: (detail.responseChunks ?? [])
          .map((c) => (c._tag === 'text' && typeof c.text === 'string' ? c.text : ''))
          .join(''),
      }
    }),
  }
  const { llmDetails: _omit, ...rest } = meta
  return { ...rest, segments: [segment] }
}

/** 读取会话 metadata.segments（读取时顺带迁移旧 llmDetails）。 */
export async function getLLMSegments(handle: DB, id: string): Promise<LLMSegment[]> {
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  if (!row) return []
  const meta = migrateLegacyDetails((row.metadata ?? {}) as Record<string, unknown>)
  return (meta.segments as LLMSegment[] | undefined) ?? []
}

/** 全量替换会话 metadata.segments（每轮 loop 结束写入；段数据轻量）。 */
export async function saveLLMSegments(
  handle: DB,
  id: string,
  segments: LLMSegment[],
): Promise<void> {
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  if (!row) return
  const meta = migrateLegacyDetails((row.metadata ?? {}) as Record<string, unknown>)
  const { segments: _omit, ...rest } = meta
  const next = { ...rest, segments }
  await handle.db
    .update(sessions)
    .set({ metadata: next, updatedAt: new Date() })
    .where(eq(sessions.id, id))
}

/** 更新会话 metadata.lastRun（agent run 开始/结束时写入；重启后检测中断用）。 */
async function updateSessionLastRun(handle: DB, id: string, lastRun: LastRun): Promise<void> {
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  if (!row) return
  const meta = (row.metadata ?? {}) as SessionMetadata
  await handle.db
    .update(sessions)
    .set({ metadata: { ...meta, lastRun }, updatedAt: new Date() })
    .where(eq(sessions.id, id))
}

async function listSessionsByProject(handle: DB, projectId: string): Promise<Session[]> {
  const rows = await handle.db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.projectId, projectId),
        isNull(sessions.deletedAt),
        or(isNull(sessions.source), ne(sessions.source, 'cli')),
      ),
    )
  return rows.map(rowToSession)
}

/**
 * 跨会话搜索（P2-6）：标题 + 消息内容子串匹配。
 * 仅搜索未软删除的非 CLI 会话（与 Web 会话树一致）；projectId 提供时限定项目。
 * 返回 { session, matchedBy: 'title' | 'content' }。
 */
async function searchSessions(
  handle: DB,
  query: string,
  projectId?: string,
): Promise<Array<{ session: Session; matchedBy: 'title' | 'content' }>> {
  const needle = query.trim()
  if (!needle) return []
  const pattern = `%${needle.replace(/[%_\\]/g, '\\$&')}%`

  const baseWhere = and(
    isNull(sessions.deletedAt),
    or(isNull(sessions.source), ne(sessions.source, 'cli')),
    ...(projectId ? [eq(sessions.projectId, projectId)] : []),
  )

  // 标题命中（ILIKE 转义后按字面子串）
  const byTitle = await handle.db
    .select()
    .from(sessions)
    .where(and(baseWhere, ilike(sessions.title, pattern)))
  const byContent = await handle.db
    .selectDistinctOn([sessions.id], {
      id: sessions.id,
      title: sessions.title,
      parentId: sessions.parentId,
      projectId: sessions.projectId,
      branchPoint: sessions.branchPoint,
      metadata: sessions.metadata,
      agentType: sessions.agentType,
      worktreePath: sessions.worktreePath,
      source: sessions.source,
      deletedAt: sessions.deletedAt,
      createdAt: sessions.createdAt,
      updatedAt: sessions.updatedAt,
    })
    .from(sessionEntries)
    .innerJoin(sessions, eq(sessionEntries.sessionId, sessions.id))
    .where(
      and(
        baseWhere,
        eq(sessionEntries.tag, 'message'),
        sql`${sessionEntries.content}::text ILIKE ${pattern}`,
      ),
    )
    .orderBy(sessions.id, sessions.updatedAt)

  const result: Array<{ session: Session; matchedBy: 'title' | 'content' }> = []
  const seen = new Set<string>()
  for (const row of byTitle) {
    const s = rowToSession(row)
    result.push({ session: s, matchedBy: 'title' })
    seen.add(s.id)
  }
  for (const row of byContent) {
    const s = rowToSession(row)
    if (!seen.has(s.id)) {
      result.push({ session: s, matchedBy: 'content' })
      seen.add(s.id)
    }
  }
  return result
}

export {
  createSession,
  emptyTrash,
  getSession,
  listAllSessions,
  listDeletedSessions,
  listSessions,
  listSessionsByProject,
  permanentlyDeleteSession,
  purgeDeletedSessions,
  purgeTemporarySessions,
  rebindSession,
  restoreSession,
  searchSessions,
  softDeleteSession,
  touchLastOpened,
  touchSession,
  updateSessionLastRun,
  updateSessionTitle,
  upgradeTemporarySession,
}
