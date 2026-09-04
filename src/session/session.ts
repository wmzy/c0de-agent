import { and, eq, gt, inArray, isNull, lt, ne, or } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { sessions } from '../db/schema.js'
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
): Promise<Session> {
  const [row] = await handle.db
    .insert(sessions)
    .values({
      title,
      projectId: projectId ?? null,
      agentType: agentType ?? null,
      source: source ?? null,
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

/** List soft-deleted sessions (回收站). */
async function listDeletedSessions(handle: DB): Promise<Session[]> {
  const rows = await handle.db
    .select()
    .from(sessions)
    .where(gt(sessions.deletedAt, new Date(0)))
  return rows.map(rowToSession)
}

/**
 * 软删除会话（级联其所有 fork 后代）。设置 deletedAt = now；
 * 30 天后由 purgeDeletedSessions 物理清除。
 */
async function softDeleteSession(handle: DB, id: string): Promise<boolean> {
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
  if (!ids.has(id)) return false
  const now = new Date()
  for (const sid of ids) {
    await handle.db.update(sessions).set({ deletedAt: now }).where(eq(sessions.id, sid))
  }
  return true
}

/** 从回收站恢复会话（仅该会话本身，不清除其祖先/后代的删除标记）。 */
async function restoreSession(handle: DB, id: string): Promise<boolean> {
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  if (!row || !row.deletedAt) return false
  await handle.db.update(sessions).set({ deletedAt: null }).where(eq(sessions.id, id))
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

export {
  createSession,
  getSession,
  listAllSessions,
  listDeletedSessions,
  listSessions,
  listSessionsByProject,
  purgeDeletedSessions,
  restoreSession,
  softDeleteSession,
  touchLastOpened,
  touchSession,
  updateSessionLastRun,
  updateSessionTitle,
}
