/**
 * 会话 CRUD 与轻量 metadata 更新：行的创建/读取/各口径列表/跨会话搜索，
 * 以及不涉及删除生命周期的 metadata 写入（标题、touch、lastRun、预算暂停标记、
 * 中断轮次标记）。回收站与删除生命周期见 trash.ts；LLM 段管理见 segments.ts。
 * updateSessionMetadata 是三个模块共享的 metadata 读-改-写入口，归属本模块。
 */
import { and, eq, gt, ilike, isNull, ne, notInArray, or, sql } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { sessionEntries, sessions } from '../db/schema.js'
import type { HookRunner } from '../plugins/types.js'
import type { LastRun, Session, SessionMetadata } from '../shared/types/message.js'
import { getEntries } from './message.js'
import { toEpochMs } from './time.js'

/** Convert a DB row (with Date timestamps) to the shared Session type (with number timestamps). */
export function rowToSession(row: typeof sessions.$inferSelect): Session {
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
    deletedAt: row.deletedAt ? toEpochMs(row.deletedAt) : null,
    createdAt: toEpochMs(row.createdAt),
    updatedAt: toEpochMs(row.updatedAt),
  }
}

/**
 * 会话 metadata 读-改-写的统一入口：select 后经 mutate 变换再写回。
 * mutate 返回 null 表示无需写回（条件不满足/无标记），跳过 update；返回 false
 * 表示会话不存在。bumpUpdatedAt 显式传入、逐调用点保持原语义——回收站标记
 * （trashSeenAt/purgePendingAt）与 lastOpenedAt 不刷新会话活跃时间，lastRun/
 * segments/budgetPauseReason 的写入伴随 updatedAt。收敛的是读改写形状，不统一 bump。
 */
async function updateSessionMetadata(
  handle: DB,
  id: string,
  mutate: (meta: SessionMetadata) => SessionMetadata | null,
  opts: { bumpUpdatedAt?: boolean } = {},
): Promise<boolean> {
  const [row] = await handle.db
    .select({ metadata: sessions.metadata })
    .from(sessions)
    .where(eq(sessions.id, id))
  if (!row) return false
  const next = mutate((row.metadata ?? {}) as SessionMetadata)
  if (next === null) return false
  await handle.db
    .update(sessions)
    .set({
      metadata: next,
      ...(opts.bumpUpdatedAt === true ? { updatedAt: new Date() } : {}),
    })
    .where(eq(sessions.id, id))
  return true
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
  /** 插件 hook runner：创建成功后广播 session:create（可选，纯广播不阻断）。 */
  hooks?: HookRunner,
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
  const created = rowToSession(row)
  if (hooks) {
    try {
      await hooks.fireHooks('session:create', { session: created })
    } catch {
      // 广播失败绝不阻断会话创建（fireHooks 内部已吞 handler 异常，双保险）
    }
  }
  return created
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

/** Update a session's title. */
async function updateSessionTitle(handle: DB, id: string, title: string): Promise<void> {
  await handle.db.update(sessions).set({ title, updatedAt: new Date() }).where(eq(sessions.id, id))
}

/** Bump updatedAt to now (used after appending messages). */
async function touchSession(handle: DB, id: string): Promise<void> {
  await handle.db.update(sessions).set({ updatedAt: new Date() }).where(eq(sessions.id, id))
}

/** 记录会话上次打开时间（用于会话列表按最近打开排序；不刷新 updatedAt——
 *  与既有行为一致，打开不视为内容变更）。 */
async function touchLastOpened(handle: DB, id: string): Promise<void> {
  await updateSessionMetadata(handle, id, (meta) => ({ ...meta, lastOpenedAt: Date.now() }))
}

/** 更新会话 metadata.lastRun（agent run 开始/结束时写入；重启后检测中断用）。 */
async function updateSessionLastRun(handle: DB, id: string, lastRun: LastRun): Promise<void> {
  await updateSessionMetadata(handle, id, (meta) => ({ ...meta, lastRun }), {
    bumpUpdatedAt: true,
  })
}

/**
 * P2-3：预算超支暂停时把原因写入 metadata.budgetPauseReason。
 * 热更新/重启后 run 重建时由 consumeBudgetPauseMarker 消费——恢复内存
 * budgetPauseTriggered 标记，避免同一超支原因二次暂停。
 */
async function markBudgetPause(handle: DB, id: string, reason: string): Promise<void> {
  await updateSessionMetadata(handle, id, (meta) => ({ ...meta, budgetPauseReason: reason }), {
    bumpUpdatedAt: true,
  })
}

/**
 * P2-3：消费预算暂停标记（新 run 启动时调用一次）。返回上次暂停原因并删除字段；
 * 无标记返回 null。消费即删除——单次语义，之后 run 恢复常规预算检查。
 */
async function consumeBudgetPauseMarker(handle: DB, id: string): Promise<string | null> {
  let reason: string | null = null
  await updateSessionMetadata(
    handle,
    id,
    (meta) => {
      if (typeof meta.budgetPauseReason !== 'string') return null
      reason = meta.budgetPauseReason
      const { budgetPauseReason: _omit, ...rest } = meta
      return rest
    },
    { bumpUpdatedAt: true },
  )
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
  consumeBudgetPauseMarker,
  createSession,
  getSession,
  listAllSessions,
  listSessions,
  listSessionsByProject,
  markBudgetPause,
  markUnfinishedTurn,
  searchSessions,
  touchLastOpened,
  touchSession,
  updateSessionLastRun,
  updateSessionMetadata,
  updateSessionTitle,
}
