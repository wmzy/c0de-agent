/**
 * 回收站与删除生命周期：软删除（级联后代、同批次号）、恢复（祖先链/后代子树级联、
 * 孤儿重新归属）、两阶段清理（宽限标记 → 物理清除）、空会话/临时会话 GC，
 * 以及物理删除原语 deleteSessionSubtrees（自引用 FK 要求子先父后）。
 * 会话 CRUD 与常规 metadata 更新见 session.ts；LLM 段管理见 segments.ts。
 */
import { and, eq, gt, inArray, isNull, lt, notExists, or, type SQL, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { DB } from '../db/client.js'
import { sessionEntries, sessions } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import type { Session, SessionMetadata } from '../shared/types/message.js'
import { rowToSession, updateSessionMetadata } from './session.js'

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
  const rows = await handle.db.select({ id: sessions.id }).from(sessions).where(where)
  const now = Date.now()
  let touched = 0
  for (const row of rows) {
    // A3：只标记首次看到，不随每次打开重置——否则「剩余天数」虚标，
    // 经常打开回收站的用户条目永不清理，保留期形同虚设。
    const changed = await updateSessionMetadata(handle, row.id, (meta) =>
      typeof meta.trashSeenAt === 'number' ? null : { ...meta, trashSeenAt: now },
    )
    if (changed) touched += 1
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
  // 批量化：无回收站标记的行共享一条 update（不覆写 metadata，等价于原样写回）；
  // 有标记的行（trashSeenAt/purgePendingAt）metadata 互不相同，仍逐行清除。
  const plainIds: string[] = []
  const markedRows: Array<{ id: string; meta: SessionMetadata }> = []
  for (const sid of ids) {
    const raw = (metas.get(sid) ?? {}) as SessionMetadata
    const cleaned = clearTrashMarks(raw)
    if (cleaned === raw) plainIds.push(sid)
    else markedRows.push({ id: sid, meta: cleaned })
  }
  if (plainIds.length > 0) {
    await handle.db
      .update(sessions)
      .set({ deletedAt: now, deletedBatchId: batchId })
      .where(inArray(sessions.id, plainIds))
  }
  for (const { id: sid, meta } of markedRows) {
    await handle.db
      .update(sessions)
      .set({ deletedAt: now, deletedBatchId: batchId, metadata: meta })
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
 * 把「本次恢复连带还原、但恢复后仍无归属」的会话一并归属到指定项目。
 *
 * 为什么必须有这一步：项目删除时该项目下所有会话被 FK set null 变成孤儿
 * （同时软删除进回收站），因此用户在回收站「未归属项目」分组里恢复的往往是
 * **子会话**，祖先链（更早删除/同批次的根会话）会被 restoreSessionCore
 * 连带还原——但只有目标会话拿到归属。而侧栏按**根会话**的 projectId 过滤整棵
 * 树（SessionList.filterTree），根仍为 null 时：
 *   - 恢复成功的会话在侧栏里一条都看不见（提示却说「已恢复并归属到当前项目」）；
 *   - 被连带还原的祖先已不再是「已删除」会话，回收站的孤儿分组又只列已删会话，
 *     于是它成了没有任何列表入口的孤儿行，永远不可达。
 *
 * 只对当前无归属的会话生效：已有归属的祖先属于别的项目（跨批次删除的祖先），
 * 恢复后自然出现在它自己的项目视图里，不动它。返回真正被归属的会话 id。
 */
async function rebindUnboundSessions(
  handle: DB,
  ids: Iterable<string>,
  project: { id: string; worktree: string },
): Promise<string[]> {
  const adopted: string[] = []
  for (const sid of ids) {
    const [row] = await handle.db
      .select({ projectId: sessions.projectId })
      .from(sessions)
      .where(eq(sessions.id, sid))
    if (!row || row.projectId) continue
    if (await rebindSession(handle, sid, project)) adopted.push(sid)
  }
  return adopted
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
  /**
   * 本次恢复**实际**还原出的会话 id（目标 + 连带的后代子树 + 连带还原的祖先链）。
   *
   * 调用方需要它才能保证恢复后的可达性：删除项目时整批会话被 FK set null，
   * 「未归属项目」分组里恢复其中一条子会话时，一起还原的祖先仍是孤儿——
   * 侧栏按**根会话** projectId 过滤整棵树，根无归属则整棵子树在任何项目视图里
   * 都不出现（见 rebindUnboundSessions）。
   */
  restoredIds: string[]
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
      restoredIds: [],
    }
  const targetBatch = row.deletedBatchId
  const ids = new Set<string>([id])
  // 后代单遍 BFS：收集**全部**已删后代（任意批次，连同批次/父指针），还原集与
  // 滞留计数（A2）在同一次遍历的结果上计算。两遍 BFS 的语义差必须保留：
  // 「还原 = 从目标出发经**同批次链**可达」（跨批次桥后的同批次孙节点不因批次
  // 相同而还原），「滞留 = 已删后代中不在还原集的数量（批次不同 → 滞留回收站）」。
  let leftBehindDescendantCount = 0
  if (includeDescendants) {
    const descendants = new Map<string, { parentId: string | null; batch: string | null }>()
    let frontier = [id]
    while (frontier.length > 0) {
      const children = await handle.db
        .select({
          id: sessions.id,
          parentId: sessions.parentId,
          deletedBatchId: sessions.deletedBatchId,
        })
        .from(sessions)
        .where(and(gt(sessions.deletedAt, new Date(0)), inArray(sessions.parentId, frontier)))
      frontier = []
      for (const ch of children) {
        if (descendants.has(ch.id)) continue
        descendants.set(ch.id, { parentId: ch.parentId, batch: ch.deletedBatchId })
        frontier.push(ch.id)
      }
    }
    // 同批次链可达传播：仅还原属于同一删除批次的后代（删除时父+后代共享
    // deletedBatchId）。若只按「已删除」收集，会把早先被用户单独删除的分支
    // 一并复活（F2 不对称缺陷）。
    const childrenByParent = new Map<string, string[]>()
    for (const [cid, info] of descendants) {
      if (!info.parentId) continue
      const list = childrenByParent.get(info.parentId)
      if (list) list.push(cid)
      else childrenByParent.set(info.parentId, [cid])
    }
    const queue = [id]
    while (queue.length > 0) {
      const pid = queue.pop()
      if (pid === undefined) break
      for (const cid of childrenByParent.get(pid) ?? []) {
        if (ids.has(cid)) continue
        if ((descendants.get(cid)?.batch ?? null) === targetBatch) {
          ids.add(cid)
          queue.push(cid)
        }
      }
    }
    for (const cid of descendants.keys()) {
      if (!ids.has(cid)) leftBehindDescendantCount += 1
    }
  }
  // 祖先链（仅还原其中已软删除的节点）：为保证恢复节点在会话树可达，
  // 已删除的祖先无论批次均需一并还原。记录还原的祖先数量与是否跨越删除批次，
  // 供前端提示「为保持会话树完整，同时还原了 N 个父会话」。
  // 环守卫：parentId 成环数据（a↔b 互指/自引用，快照恢复或手改 DB 均可产生）
  // 会让 while 循环在环上无限打转（每圈一条 DB 查询，恢复请求永不返回）——
  // 已访问节点再次出现即终止，与 orderSessionsByParent/purgeDeletedSessions
  // 的同型守卫一致。
  let restoredAncestorCount = 0
  let crossedBatchAncestor = false
  let parentId = row.parentId
  const visitedAncestors = new Set<string>([id])
  while (parentId) {
    if (visitedAncestors.has(parentId)) break
    visitedAncestors.add(parentId)
    const [parent] = await handle.db.select().from(sessions).where(eq(sessions.id, parentId))
    if (!parent) break
    if (parent.deletedAt && !ids.has(parent.id)) {
      ids.add(parent.id)
      restoredAncestorCount += 1
      if (parent.deletedBatchId !== targetBatch) crossedBatchAncestor = true
    }
    parentId = parent.parentId
  }
  // 批量还原：restoreSessionCore 的还原值对全部行相同，一条 update 等价于逐行写。
  await handle.db
    .update(sessions)
    .set({ deletedAt: null, deletedBatchId: null })
    .where(inArray(sessions.id, Array.from(ids)))
  return {
    restored: true,
    restoredAncestorCount,
    crossedBatchAncestor,
    leftBehindDescendantCount,
    restoredIds: [...ids],
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

/** 清除结果：marked = 本次新标记进入宽限期的条目数；deleted = 本次物理清除行数
 *  （含随父行一并清除的后代——跨项目/未到期的子行无法在父行删除后幸存）。 */
export type TrashPurgeResult = { marked: number; deleted: number }

/**
 * 回收站两阶段清理（启动时与每日定时调用）：
 * 阶段一：进入保留期截止（首次看到 + 60 天）或绝对上限（删除 + 365 天，无论是否
 *   被看到）且未标记 → 标记 purgePendingAt（进入宽限期，可恢复）。
 * 阶段二：purgePendingAt 早于宽限截止 → 物理清除（子会话先于父，自引用 FK 要求；
 *   删除闭包含全部后代，未到期的子行随父行一并清除）。
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
      deletedAt: sessions.deletedAt,
      metadata: sessions.metadata,
    })
    .from(sessions)
    .where(gt(sessions.deletedAt, new Date(0)))

  // —— 阶段一：到期标记（先宽限，不直接清除）——
  let marked = 0
  for (const r of rows) {
    if (!r.deletedAt) continue
    const deletedMs = r.deletedAt.getTime()
    const changed = await updateSessionMetadata(handle, r.id, (meta) => {
      // 保留期自「首次看到」起算：seen 缺失或早于最近一次删除 → 未重新看到，不计。
      const seen = meta.trashSeenAt
      const seenExpired = typeof seen === 'number' && seen > deletedMs && seen < retentionCutoff
      // 绝对上限兜底：删除后长期未被看到也进入宽限期，防条目永不清理的无界增长。
      const absoluteExpired = deletedMs < absoluteCutoff
      if (!seenExpired && !absoluteExpired) return null
      if (typeof meta.purgePendingAt === 'number') return null
      return { ...meta, purgePendingAt: Date.now() }
    })
    if (changed) marked += 1
  }

  // —— 阶段二：宽限期满物理清除 ——
  const pending = rows.filter((r) => {
    if (!r.deletedAt) return false
    const meta = (r.metadata ?? {}) as SessionMetadata
    const p = meta.purgePendingAt
    return typeof p === 'number' && p < graceCutoff
  })
  if (pending.length === 0) return { marked, deleted: 0 }
  // 删除闭包含全部后代（子先父后）——pending 集合外的子行（未到期条目、跨项目
  // 归属、未软删的 fork 后代）同样引用被删父行，漏掉即撞 FK 23503 让清理整体失败。
  const deleted = await deleteSessionSubtrees(
    handle,
    pending.map((r) => r.id),
  )
  return { marked, deleted }
}

/** C4：空会话 GC 保留期（7 天）。仅覆盖「从未写入任何消息/工具条目」的会话。 */
const EMPTY_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** 「真空会话」谓词（C4）：无任何条目且无子会话。两条 notExists 子查询按外层
 *  sessions.id 关联——批量清理（purgeEmptySessions）与单条清理（purgeEmptySession，
 *  首条消息失败后的前端清理路径）共用同一谓词，防两处判定漂移。 */
function emptySessionConditions(handle: DB): SQL[] {
  const children = alias(sessions, 'empty_children')
  return [
    notExists(
      handle.db
        .select({ one: sql`1` })
        .from(sessionEntries)
        .where(eq(sessionEntries.sessionId, sessions.id)),
    ),
    notExists(
      handle.db.select({ one: sql`1` }).from(children).where(eq(children.parentId, sessions.id)),
    ),
  ]
}

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
  const result = await handle.db
    .delete(sessions)
    .where(
      and(
        lt(sessions.createdAt, cutoff),
        isNull(sessions.deletedAt),
        or(isNull(sessions.source), eq(sessions.source, 'web')),
        ...emptySessionConditions(handle),
      ),
    )
    .returning({ id: sessions.id })
  return result.length
}

/**
 * P3-9：物理删除一个「真空会话」——无任何条目且无子会话（首条消息发送失败后
 * 的前端清理路径使用）。非空会话绝不触碰（返回 false），防误删走错回收站语义。
 * 软删除会话（回收站条目）不在本路径处理。删除由 emptySessionConditions 守卫，
 * 任一条件不满足（不存在/已软删/有条目/有子会话）→ 0 行 → false。
 */
async function purgeEmptySession(handle: DB, id: string): Promise<boolean> {
  const result = await handle.db
    .delete(sessions)
    .where(and(eq(sessions.id, id), isNull(sessions.deletedAt), ...emptySessionConditions(handle)))
    .returning({ id: sessions.id })
  return result.length > 0
}

/**
 * 物理删除会话子树：rootIds + 其**全部后代**（不论删除状态与项目归属），子先父后。
 * 返回实际删除行数。
 *
 * 自引用 FK（sessions.parentId，无 onDelete 级联）要求任何引用待删行的子行先删，
 * 且子行可能不在调用方给定的清除集合内：跨项目归属（子会话经 rebind 留在另一
 * 项目）、未到期/未进入宽限期的回收站条目、乃至未软删除的 fork 后代（数据异常，
 * 与 permanentlyDeleteSession 既有防御同口径）。只按「待清除集合」排序会在这些
 * 子行上撞 FK 23503——emptyTrash(projectId) 直接 500（该项目回收站永远清不掉）、
 * purgeDeletedSessions 整体抛错（启动/每日清理静默失败，回收站永不清理）。
 * 故删除闭包必须扩展到全部后代，集合外无人引用集合内行时断开父指针亦安全。
 *
 * 环数据（parentId 互指/自引用）无拓扑序可解：无叶可删时先断开集合内父指针
 * （仅集合内引用，集合外不可能引用集合内行），再整体删除。
 */
async function deleteSessionSubtrees(handle: DB, rootIds: string[]): Promise<number> {
  if (rootIds.length === 0) return 0
  const all = await handle.db
    .select({ id: sessions.id, parentId: sessions.parentId })
    .from(sessions)
  // 邻接表（O(n) 构建/遍历）：全表行数可达数千，旧实现对每层 BFS/每轮剥叶都
  // 全量线性扫描 all（O(n²) 起步），回收站整清时是可感知的卡顿点。
  const exists = new Set<string>()
  const parentOf = new Map<string, string | null>()
  const childrenOf = new Map<string, string[]>()
  for (const r of all) {
    exists.add(r.id)
    parentOf.set(r.id, r.parentId)
    if (r.parentId) {
      const list = childrenOf.get(r.parentId)
      if (list) list.push(r.id)
      else childrenOf.set(r.parentId, [r.id])
    }
  }
  const ids = new Set<string>()
  let frontier: string[] = []
  for (const id of rootIds) {
    if (ids.has(id) || !exists.has(id)) continue
    ids.add(id)
    frontier.push(id)
  }
  while (frontier.length > 0) {
    const next: string[] = []
    for (const pid of frontier) {
      for (const cid of childrenOf.get(pid) ?? []) {
        if (ids.has(cid)) continue
        ids.add(cid)
        next.push(cid)
      }
    }
    frontier = next
  }

  // 剩余集合内「仍有子会话存活」的父节点 → 叶子 = 无存活子会话的节点。
  // liveChildren 计数只统计待删集合内的子节点（闭包保证子节点全在集合内），
  // 删叶时对父计数减一，归零即成为新叶——子先父后（自引用 FK RESTRICT）。
  const remaining = new Set(ids)
  const liveChildren = new Map<string, number>()
  let leaves: string[] = []
  for (const rid of ids) {
    let n = 0
    for (const cid of childrenOf.get(rid) ?? []) if (ids.has(cid)) n += 1
    liveChildren.set(rid, n)
    if (n === 0) leaves.push(rid)
  }
  let deleted = 0
  while (remaining.size > 0) {
    if (leaves.length === 0) {
      // 环兜底：集合内成环（a↔b / 自引用），无叶可删——断开父指针后整体删除。
      const cycleIds = Array.from(remaining)
      await handle.db.update(sessions).set({ parentId: null }).where(inArray(sessions.id, cycleIds))
      const rows = await handle.db
        .delete(sessions)
        .where(inArray(sessions.id, cycleIds))
        .returning({ id: sessions.id })
      deleted += rows.length
      break
    }
    const rows = await handle.db
      .delete(sessions)
      .where(inArray(sessions.id, leaves))
      .returning({ id: sessions.id })
    deleted += rows.length
    const nextLeaves: string[] = []
    for (const rid of leaves) {
      remaining.delete(rid)
      const pid = parentOf.get(rid)
      if (pid !== null && pid !== undefined && remaining.has(pid)) {
        const n = (liveChildren.get(pid) ?? 0) - 1
        liveChildren.set(pid, n)
        if (n === 0) nextLeaves.push(pid)
      }
    }
    leaves = nextLeaves
  }
  return deleted
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
  return deleteSessionSubtrees(handle, [id])
}

/** 清空回收站：物理删除所有已软删除会话（子先于父，连同其全部后代）。
 *  projectId 提供时仅以该项目条目为根（P1-7）——后代闭包仍含其他项目的子行
 *  （它们引用被删父行，必须同批删除）。返回删除数量。 */
async function emptyTrash(handle: DB, projectId?: string): Promise<number> {
  const rows = await handle.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      projectId
        ? and(gt(sessions.deletedAt, new Date(0)), eq(sessions.projectId, projectId))
        : gt(sessions.deletedAt, new Date(0)),
    )
  return deleteSessionSubtrees(
    handle,
    rows.map((r) => r.id),
  )
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
  // 过滤下推 SQL：仅取「显式标记的临时会话 + 超过保留期」的根，避免全量拉取
  // 未删除会话后在内存过滤（updatedAt 非空，lt 语义与旧 JS 过滤一致）。
  const rows = await handle.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        isNull(sessions.deletedAt),
        inArray(sessions.agentType, ['print', 'workflow']),
        lt(sessions.updatedAt, cutoff),
      ),
    )
  let trashed = 0
  for (const r of rows) {
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

export {
  clearTrashMarks,
  emptyTrash,
  listDeletedSessions,
  listOrphanDeletedSessions,
  permanentlyDeleteSession,
  purgeDeletedSessions,
  purgeEmptySession,
  purgeEmptySessions,
  purgeTemporarySessions,
  rebindSession,
  rebindUnboundSessions,
  restoreSession,
  restoreSessionCore,
  softDeleteSession,
  touchTrashSeen,
  upgradeTemporarySession,
}
