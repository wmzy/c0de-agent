import {
  and,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { DB } from '../db/client.js'
import { sessionEntries, sessions } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import type { LLMSegment } from '../shared/types/agent.js'
import type { ChatTool } from '../shared/types/llm.js'
import type { LastRun, Session, SessionMetadata } from '../shared/types/message.js'
import { getEntries } from './message.js'

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
  /** 会话工作目录（CLI 会话必填：Web 打开时 agent 工具在该目录执行，而非 serve cwd）。 */
  worktreePath?: string,
  /** 初始 metadata（如工作流运行会话记录 workflowName，供中断恢复指引展示）。 */
  metadata?: Record<string, unknown>,
): Promise<Session> {
  const [row] = await handle.db
    .insert(sessions)
    .values({
      title,
      projectId: projectId ?? null,
      agentType: agentType ?? null,
      source: source ?? null,
      parentId: parentId ?? null,
      worktreePath: worktreePath ?? null,
      ...(metadata ? { metadata } : {}),
    })
    .returning()
  if (!row) throw new Error('Failed to insert session')
  return rowToSession(row)
}

/**
 * Web 会话树可见性条件：web 会话（source 为 null/web）或「持久的 CLI 会话」。
 * 一次性 CLI print 会话与 CLI 来源的 workflow 会话是临时数据，隐藏；
 * Web 来源的 workflow 会话（source=null）在树中可见（标题带时间戳）。
 * 两类临时会话到期后统一**移入回收站**（purgeTemporarySessions），不再物理清除——
 * 可见节点（含其子 agent 会话）享有 60 天可恢复承诺。
 * --continue 续接后 agentType 已清除（upgradeTemporarySession），即对 Web 可见。
 */
export function webVisibleSessionCondition() {
  return or(
    isNull(sessions.source),
    ne(sessions.source, 'cli'),
    and(
      eq(sessions.source, 'cli'),
      or(isNull(sessions.agentType), notInArray(sessions.agentType, ['print', 'workflow'])),
    ),
  )
}

/** Get a session by id, or null if not found. */
async function getSession(handle: DB, id: string): Promise<Session | null> {
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  return row ? rowToSession(row) : null
}

/** List all active sessions（未软删除、Web 树可见：web 会话 + 持久化 CLI 会话）。 */
async function listSessions(handle: DB): Promise<Session[]> {
  const rows = await handle.db
    .select()
    .from(sessions)
    .where(and(isNull(sessions.deletedAt), webVisibleSessionCondition()))
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

/** 列出未归属任何项目的已软删除会话（孤儿）。删除项目时 FK set null 使会话失去 projectId，
 *  在任何项目的回收站视图都不可见（F1），需专门的全局视图暴露以便恢复/归巢。 */
async function listOrphanDeletedSessions(handle: DB): Promise<Session[]> {
  const rows = await handle.db
    .select()
    .from(sessions)
    .where(and(gt(sessions.deletedAt, new Date(0)), isNull(sessions.projectId)))
  return rows.map(rowToSession)
}

/**
 * 标记回收站条目「已被用户看到」，记录 metadata.trashSeenAt = now（仅首次，不重置）。
 * 回收站保留期自首次看到起算（见 purgeDeletedSessions）。语义为分组粒度（M1）：
 * 一次调用标记 scope 内全部条目——「首次看到」指用户打开该回收站分组，而非逐条
 * 浏览到某个条目；分组内条目同时起算，列表按到期先后置顶展示以补偿该粒度。
 * 软删除时会清除旧标记，恢复后再次删除须重新看到回收站才重新起算——
 * 避免「未重新看到就被过早清空」。
 * scope.orphan=true 时仅标记未归属项目的孤儿会话（与 listOrphanDeletedSessions 对齐）；
 * 孤儿标记仅在用户展开「未归属项目」分组时由前端显式调用（POST /deleted/orphans/seen），
 * 避免打开任意项目回收站连带启动无关孤儿条目的倒计时。
 */
async function touchTrashSeen(
  handle: DB,
  scope: { projectId?: string; orphan?: boolean } = {},
): Promise<number> {
  const where = scope.orphan
    ? and(gt(sessions.deletedAt, new Date(0)), isNull(sessions.projectId))
    : scope.projectId
      ? and(gt(sessions.deletedAt, new Date(0)), eq(sessions.projectId, scope.projectId))
      : gt(sessions.deletedAt, new Date(0))
  const rows = await handle.db
    .select({ id: sessions.id, metadata: sessions.metadata })
    .from(sessions)
    .where(where)
  const now = Date.now()
  let touched = 0
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as SessionMetadata
    // A3：只标记首次看到，不随每次打开重置——否则「剩余天数」虚标，
    // 经常打开回收站的用户条目永不清理，保留期形同虚设。
    if (typeof meta.trashSeenAt === 'number') continue
    await handle.db
      .update(sessions)
      .set({ metadata: { ...meta, trashSeenAt: now } })
      .where(eq(sessions.id, row.id))
    touched += 1
  }
  return touched
}

/**
 * 软删除会话（级联其所有 fork 后代）。设置 deletedAt = now；
 * 60 天后由 purgeDeletedSessions 物理清除（到期先标记、宽限 7 天）。
 * A3：同时清除 trashSeenAt/purgePendingAt——恢复后重删的会话必须重新被
 * 用户看到才重新起算，宽限期标记不跨删除周期生效。
 * 会话不存在或已在回收站 → 返回 false（调用方按 404 处理）。
 */
async function softDeleteSession(handle: DB, id: string): Promise<boolean> {
  const [row] = await handle.db
    .select({ id: sessions.id, deletedAt: sessions.deletedAt, metadata: sessions.metadata })
    .from(sessions)
    .where(eq(sessions.id, id))
  if (!row || row.deletedAt) return false
  const ids = new Set<string>([id])
  const metas = new Map<string, unknown>([[id, row.metadata]])
  let frontier = [id]
  while (frontier.length > 0) {
    // 用 parentId 过滤：收集下一层子会话
    const children = await handle.db
      .select({ id: sessions.id, metadata: sessions.metadata })
      .from(sessions)
      .where(and(isNull(sessions.deletedAt), inArray(sessions.parentId, frontier)))
    frontier = children.map((r) => r.id).filter((cid) => !ids.has(cid))
    for (const r of children) {
      ids.add(r.id)
      metas.set(r.id, r.metadata)
    }
  }
  const now = new Date()
  // 同一次删除级联共享同一批次号：恢复时仅还原同批次后代，避免把早先
  // 被用户单独删除的分支一并复活（删除/恢复级联的语义不对称缺陷）。
  const batchId = generateId()
  for (const sid of ids) {
    await handle.db
      .update(sessions)
      .set({
        deletedAt: now,
        deletedBatchId: batchId,
        metadata: clearTrashMarks((metas.get(sid) ?? {}) as SessionMetadata),
      })
      .where(eq(sessions.id, sid))
  }
  return true
}

/**
 * A3：清除回收站倒计时/宽限期标记（软删除与项目删除共用）。
 * 恢复后重删的会话须重新被看到才重新起算；宽限期标记不跨删除周期生效。
 * 无标记时原样返回，避免无谓的 jsonb 覆写。
 */
function clearTrashMarks(meta: SessionMetadata): SessionMetadata {
  if (typeof meta.trashSeenAt !== 'number' && typeof meta.purgePendingAt !== 'number') return meta
  const { trashSeenAt: _seen, purgePendingAt: _purge, ...rest } = meta
  return rest
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
 *
 * P2 修复：删除级联后代入回收站，恢复同样级联还原目标会话的整棵后代子树——
 * 否则「删除根会话 → 恢复根会话」后分支仍滞留回收站且无任何提示，保留期后被清。
 * 兄弟分支（祖先的其他后代）不受影响。
 */
export type RestoreResult = {
  restored: boolean
  /** 为可达性连带还原的祖先会话数量（不含目标会话与其同批次后代）。 */
  restoredAncestorCount: number
  /** 是否连带还原了与目标非同一次删除批次的祖先（用户早先单独删除的会话）。 */
  crossedBatchAncestor: boolean
  /**
   * A2：已删除但未随本次恢复的后代数量（删除批次不同——典型场景是项目删除时
   * 各会话批次断裂）。这些 fork 分支滞留在回收站，必须显式告知用户单独恢复，
   * 否则会被静默物理清除。
   */
  leftBehindDescendantCount: number
}

async function restoreSessionCore(
  handle: DB,
  id: string,
  opts: { includeDescendants?: boolean } = {},
): Promise<RestoreResult> {
  const includeDescendants = opts.includeDescendants !== false
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  if (!row?.deletedAt)
    return {
      restored: false,
      restoredAncestorCount: 0,
      crossedBatchAncestor: false,
      leftBehindDescendantCount: 0,
    }
  const targetBatch = row.deletedBatchId
  const ids = new Set<string>([id])
  // 后代 BFS：仅还原属于同一删除批次的后代（删除时父+后代共享 deletedBatchId）。
  // 若只按「已删除」收集，会把早先被用户单独删除的分支一并复活（F2 不对称缺陷）。
  if (includeDescendants) {
    let frontier = [id]
    while (frontier.length > 0) {
      const children = await handle.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            gt(sessions.deletedAt, new Date(0)),
            inArray(sessions.parentId, frontier),
            row.deletedBatchId
              ? eq(sessions.deletedBatchId, row.deletedBatchId)
              : isNull(sessions.deletedBatchId),
          ),
        )
      frontier = children.map((r) => r.id).filter((cid) => !ids.has(cid))
      for (const r of children) ids.add(r.id)
    }
  }
  // A2：统计所有已删后代中未随本次恢复的数量（批次不同 → 滞留回收站）。
  let leftBehindDescendantCount = 0
  if (includeDescendants) {
    const seen = new Set<string>()
    let frontier = [id]
    while (frontier.length > 0) {
      const children = await handle.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(gt(sessions.deletedAt, new Date(0)), inArray(sessions.parentId, frontier)))
      frontier = []
      for (const ch of children) {
        if (seen.has(ch.id)) continue
        seen.add(ch.id)
        frontier.push(ch.id)
        if (!ids.has(ch.id)) leftBehindDescendantCount += 1
      }
    }
  }
  // 祖先链（仅还原其中已软删除的节点）：为保证恢复节点在会话树可达，
  // 已删除的祖先无论批次均需一并还原。记录还原的祖先数量与是否跨越删除批次，
  // 供前端提示「为保持会话树完整，同时还原了 N 个父会话」。
  let restoredAncestorCount = 0
  let crossedBatchAncestor = false
  let parentId = row.parentId
  while (parentId) {
    const [parent] = await handle.db.select().from(sessions).where(eq(sessions.id, parentId))
    if (!parent) break
    if (parent.deletedAt && !ids.has(parent.id)) {
      ids.add(parent.id)
      restoredAncestorCount += 1
      if (parent.deletedBatchId !== targetBatch) crossedBatchAncestor = true
    }
    parentId = parent.parentId
  }
  for (const sid of ids) {
    await handle.db
      .update(sessions)
      .set({ deletedAt: null, deletedBatchId: null })
      .where(eq(sessions.id, sid))
  }
  return {
    restored: true,
    restoredAncestorCount,
    crossedBatchAncestor,
    leftBehindDescendantCount,
  }
}

async function restoreSession(
  handle: DB,
  id: string,
  opts: { includeDescendants?: boolean } = {},
): Promise<boolean> {
  return (await restoreSessionCore(handle, id, opts)).restored
}

/**
 * P2-4：回收站保留期 60 天（原 30 天），自「用户首次在回收站看到该条目」
 * （metadata.trashSeenAt）起算，而非删除时间（墙钟）——否则用户删除后长期不开服务、
 * 重启即被静默物理清除，从未见过任何倒计时。临时会话（CLI print / workflow）保留期
 * 仍为 30 天，见 purgeTemporarySessions。
 */
export const TRASH_RETENTION_MS = 60 * 24 * 60 * 60 * 1000

/**
 * 绝对上限（365 天）：自删除起超过此时长的条目，无论是否被看到都进入宽限期清理。
 * 兜底「用户从不开回收站 → trashSeenAt 永不写入 → 条目永不清理」的无界增长死角。
 * 到期仍走先标记（宽限 7 天、UI 显示「即将清除」可恢复）再物理清除的两阶段流程。
 */
export const TRASH_ABSOLUTE_MAX_MS = 365 * 24 * 60 * 60 * 1000

/**
 * A3：到期标记 → 物理清除的宽限期（默认 7 天）。
 * 条目到期后先写 metadata.purgePendingAt，UI 显示「即将清除」并可恢复；
 * 宽限期满才物理清除——杜绝「到期即静默物理清空」的数据丢失死角。
 */
export const TRASH_PURGE_GRACE_MS = 7 * 24 * 60 * 60 * 1000

/** 清除结果：marked = 本次新标记进入宽限期的条目数；deleted = 本次物理清除数。 */
export type TrashPurgeResult = { marked: number; deleted: number }

/**
 * 回收站两阶段清理（启动时与每日定时调用）：
 * 阶段一：进入保留期截止（首次看到 + 60 天）或绝对上限（删除 + 365 天，无论是否
 *   被看到）且未标记 → 标记 purgePendingAt（进入宽限期，可恢复）。
 * 阶段二：purgePendingAt 早于宽限截止 → 物理清除（子会话先于父，自引用 FK 要求）。
 * 恢复后重删、尚未重新看到的会话按「首次看到 + 60 天」计（绝对上限兜底仍生效）。
 */
async function purgeDeletedSessions(
  handle: DB,
  retentionMs = TRASH_RETENTION_MS,
  graceMs = TRASH_PURGE_GRACE_MS,
): Promise<TrashPurgeResult> {
  const retentionCutoff = Date.now() - retentionMs
  const graceCutoff = Date.now() - graceMs
  const absoluteCutoff = Date.now() - TRASH_ABSOLUTE_MAX_MS
  const rows = await handle.db
    .select({
      id: sessions.id,
      parentId: sessions.parentId,
      deletedAt: sessions.deletedAt,
      metadata: sessions.metadata,
    })
    .from(sessions)
    .where(gt(sessions.deletedAt, new Date(0)))

  // —— 阶段一：到期标记（先宽限，不直接清除）——
  let marked = 0
  for (const r of rows) {
    if (!r.deletedAt) continue
    const meta = (r.metadata ?? {}) as SessionMetadata
    const seen = meta.trashSeenAt
    const deletedMs = r.deletedAt.getTime()
    // 保留期自「首次看到」起算：seen 缺失或早于最近一次删除 → 未重新看到，不计。
    const seenExpired = typeof seen === 'number' && seen > deletedMs && seen < retentionCutoff
    // 绝对上限兜底：删除后长期未被看到也进入宽限期，防条目永不清理的无界增长。
    const absoluteExpired = deletedMs < absoluteCutoff
    if (!seenExpired && !absoluteExpired) continue
    if (typeof meta.purgePendingAt === 'number') continue
    await handle.db
      .update(sessions)
      .set({ metadata: { ...meta, purgePendingAt: Date.now() } })
      .where(eq(sessions.id, r.id))
    marked += 1
  }

  // —— 阶段二：宽限期满物理清除 ——
  const pending = rows.filter((r) => {
    if (!r.deletedAt) return false
    const meta = (r.metadata ?? {}) as SessionMetadata
    const p = meta.purgePendingAt
    return typeof p === 'number' && p < graceCutoff
  })
  let deleted = 0
  if (pending.length > 0) {
    // 拓扑序：无子会话的先删
    const remaining = new Set(pending.map((r) => r.id))
    while (remaining.size > 0) {
      const hasChildParent = new Set(
        pending.filter((r) => r.parentId && remaining.has(r.parentId)).map((r) => r.parentId),
      )
      const leaves = pending
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
  }
  return { marked, deleted }
}

/** C4：空会话 GC 保留期（7 天）。仅覆盖「从未写入任何消息/工具条目」的会话。 */
const EMPTY_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * C4：清理长期空置的 web 会话（无任何条目、无子会话、未删除、创建早于保留期）。
 * 覆盖「新建会话后未发言」的残留：首条消息失败清理依赖前端 JS 执行，
 * 崩溃/断电/离线时必然残留空「New Session」行。CLI 临时会话由 purgeTemporarySessions 负责。
 */
async function purgeEmptySessions(
  handle: DB,
  retentionMs = EMPTY_SESSION_RETENTION_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionMs)
  const children = alias(sessions, 'empty_children')
  const result = await handle.db
    .delete(sessions)
    .where(
      and(
        lt(sessions.createdAt, cutoff),
        isNull(sessions.deletedAt),
        or(isNull(sessions.source), eq(sessions.source, 'web')),
        notExists(
          handle.db
            .select({ one: sql`1` })
            .from(sessionEntries)
            .where(eq(sessionEntries.sessionId, sessions.id)),
        ),
        notExists(
          handle.db
            .select({ one: sql`1` })
            .from(children)
            .where(eq(children.parentId, sessions.id)),
        ),
      ),
    )
    .returning({ id: sessions.id })
  return result.length
}

/** Update a session's title. */
async function updateSessionTitle(handle: DB, id: string, title: string): Promise<void> {
  await handle.db.update(sessions).set({ title, updatedAt: new Date() }).where(eq(sessions.id, id))
}

/**
 * P3-9：物理删除一个「真空会话」——无任何条目且无子会话（首条消息发送失败后
 * 的前端清理路径使用）。非空会话绝不触碰（返回 false），防误删走错回收站语义。
 * 软删除会话（回收站条目）不在本路径处理。
 */
async function purgeEmptySession(handle: DB, id: string): Promise<boolean> {
  const [row] = await handle.db
    .select({ id: sessions.id, deletedAt: sessions.deletedAt })
    .from(sessions)
    .where(eq(sessions.id, id))
  if (!row || row.deletedAt) return false
  const children = alias(sessions, 'purge_children')
  const [entry] = await handle.db
    .select({ one: sql`1` })
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, id))
    .limit(1)
  if (entry) return false
  const [child] = await handle.db
    .select({ one: sql`1` })
    .from(children)
    .where(eq(children.parentId, id))
    .limit(1)
  if (child) return false
  await handle.db.delete(sessions).where(eq(sessions.id, id))
  return true
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
 * 清理过期临时会话（P2 → P1 收紧：仅处理显式标记的临时会话）。
 * - agentType='print'：CLI 一次性问答（c0de chat，非 --continue）创建的会话。
 * - agentType='workflow'：工作流运行产生的会话。
 * 普通 CLI 会话（ACP）与 --continue 续接的会话（续接时已升级）永不清理——
 * 此前按 source='cli' 全删会把用户显式续接的历史静默物理删除。
 * 保留期默认 30 天。
 *
 * P1（本轮）：清理方式从物理删除改为**移入回收站**（softDeleteSession）——
 * 工作流/print 会话的子 agent 会话在 Web 树中可见，此前「30 天到点即物理清除」
 * 让可见节点无回收站保护地凭空消失，与「60 天可恢复」的产品承诺冲突。
 * 软删除级联同批次后代；随后由 purgeDeletedSessions 的两阶段回收站机制
 * （trashSeenAt 60 天 / 绝对上限 365 天 + 7 天宽限）统一兜底。
 * 返回本次移入回收站的会话数。
 */
async function purgeTemporarySessions(
  handle: DB,
  retentionMs = 30 * 24 * 60 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionMs)
  const rows = await handle.db
    .select({ id: sessions.id, agentType: sessions.agentType, updatedAt: sessions.updatedAt })
    .from(sessions)
    .where(isNull(sessions.deletedAt))
  const roots = rows.filter(
    (r) =>
      (r.agentType === 'print' || r.agentType === 'workflow') &&
      r.updatedAt != null &&
      r.updatedAt.getTime() < cutoff.getTime(),
  )
  let trashed = 0
  for (const r of roots) {
    // softDeleteSession 级联标记其后代（同 deletedBatchId），恢复父即恢复子树。
    if (await softDeleteSession(handle, r.id)) trashed += 1
  }
  return trashed
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

/**
 * P2-3：预算超支暂停时把原因写入 metadata.budgetPauseReason。
 * 热更新/重启后 run 重建时由 consumeBudgetPauseMarker 消费——恢复内存
 * budgetPauseTriggered 标记，避免同一超支原因二次暂停。
 */
async function markBudgetPause(handle: DB, id: string, reason: string): Promise<void> {
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  if (!row) return
  const meta = (row.metadata ?? {}) as SessionMetadata
  await handle.db
    .update(sessions)
    .set({ metadata: { ...meta, budgetPauseReason: reason }, updatedAt: new Date() })
    .where(eq(sessions.id, id))
}

/**
 * P2-3：消费预算暂停标记（新 run 启动时调用一次）。返回上次暂停原因并删除字段；
 * 无标记返回 null。消费即删除——单次语义，之后 run 恢复常规预算检查。
 */
async function consumeBudgetPauseMarker(handle: DB, id: string): Promise<string | null> {
  const [row] = await handle.db
    .select({ metadata: sessions.metadata })
    .from(sessions)
    .where(eq(sessions.id, id))
  if (!row) return null
  const meta = (row.metadata ?? {}) as SessionMetadata
  const reason = typeof meta.budgetPauseReason === 'string' ? meta.budgetPauseReason : null
  if (reason === null) return null
  const { budgetPauseReason: _omit, ...rest } = meta
  await handle.db
    .update(sessions)
    .set({ metadata: rest, updatedAt: new Date() })
    .where(eq(sessions.id, id))
  return reason
}

async function listSessionsByProject(handle: DB, projectId: string): Promise<Session[]> {
  const rows = await handle.db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.projectId, projectId),
        isNull(sessions.deletedAt),
        webVisibleSessionCondition(),
      ),
    )
  return rows.map(rowToSession)
}

/**
 * 跨会话搜索（P2-6）：标题 + 消息内容子串匹配。
 * 默认仅搜索未软删除的非 CLI 会话（与 Web 会话树一致）；projectId 提供时限定项目。
 * opts.includeDeleted=true 时搜索回收站（P3：回收站无搜索，删后找内容只能逐行翻）。
 * 返回 { session, matchedBy: 'title' | 'content' }。
 */
async function searchSessions(
  handle: DB,
  query: string,
  projectId?: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<Array<{ session: Session; matchedBy: 'title' | 'content' }>> {
  const needle = query.trim()
  if (!needle) return []
  const pattern = `%${needle.replace(/[%_\\]/g, '\\$&')}%`

  const baseWhere = and(
    opts.includeDeleted ? gt(sessions.deletedAt, new Date(0)) : isNull(sessions.deletedAt),
    // 回收站搜索与回收站列表（listDeletedSessions）一致：不过滤 source。
    ...(opts.includeDeleted ? [] : [webVisibleSessionCondition()]),
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
      deletedBatchId: sessions.deletedBatchId,
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

/**
 * M3：把中断 run 的半截轮次标记为「未完成」——写入 metadata 的
 * (unfinishedSinceEntryId, unfinishedUntilEntryId] 区间。
 * 检测条件：lastRun.status 仍为 running/paused（进程崩溃/重启或热更新交接
 * 未能写入 completed；deliberate abort 由 SSE finally 正常写 completed，不误标）。
 * 边界 = 最后一条含文本的 user 消息；其后的条目全部属中断轮次——
 * 上下文构建剔除（context.ts），前端时间线置灰。
 * 边界已是最后一条 → 无半截内容，跳过标记。
 * 重复中断：区间起点不变（重发不追加 user 消息），终点推进到最新末尾，天然合并。
 */
async function markUnfinishedTurn(handle: DB, sessionId: string): Promise<void> {
  const [row] = await handle.db
    .select({ metadata: sessions.metadata })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
  if (!row) return
  const meta = (row.metadata ?? {}) as SessionMetadata
  const status = meta.lastRun?.status
  if (status !== 'running' && status !== 'paused') return
  const entries = await getEntries(handle, sessionId)
  let lastUserIdx = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    // P1-2：边界取「含任意内容（text 或 image）的 user 消息」——此前仅认 text，
    // 纯图片消息不在边界判定内，中断轮次起点会错误回退到更早的文本消息。
    if (
      e &&
      !('_tag' in e) &&
      e.role === 'user' &&
      e.content.some((p) => p._tag === 'text' || p._tag === 'image')
    ) {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0 || lastUserIdx === entries.length - 1) return
  const sinceId = entries[lastUserIdx]?.id
  const untilId = entries[entries.length - 1]?.id
  if (!sinceId || !untilId) return
  await handle.db
    .update(sessions)
    .set({
      metadata: { ...meta, unfinishedSinceEntryId: sinceId, unfinishedUntilEntryId: untilId },
    })
    .where(eq(sessions.id, sessionId))
}

export {
  clearTrashMarks,
  consumeBudgetPauseMarker,
  createSession,
  emptyTrash,
  getSession,
  listAllSessions,
  listDeletedSessions,
  listOrphanDeletedSessions,
  listSessions,
  listSessionsByProject,
  markBudgetPause,
  markUnfinishedTurn,
  permanentlyDeleteSession,
  purgeDeletedSessions,
  purgeEmptySession,
  purgeEmptySessions,
  purgeTemporarySessions,
  rebindSession,
  restoreSession,
  restoreSessionCore,
  searchSessions,
  softDeleteSession,
  touchLastOpened,
  touchSession,
  touchTrashSeen,
  updateSessionLastRun,
  updateSessionTitle,
  upgradeTemporarySession,
}
