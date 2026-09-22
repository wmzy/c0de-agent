import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { sessionEntries, sessions } from '../db/schema.js'

/** 序列化后的会话行（Date → epoch ms，纯 JSON 安全）。 */
type SerializedSession = {
  id: string
  title: string
  parentId: string | null
  projectId: string | null
  branchPoint: number | null
  metadata: unknown
  agentType: string | null
  worktreePath: string | null
  source: string | null
  deletedAt: number | null
  deletedBatchId: string | null
  createdAt: number
  updatedAt: number
}

/** 序列化后的会话条目行（Date → epoch ms）。 */
type SerializedEntry = {
  id: string
  sessionId: string
  tag: string
  role: string | null
  content: unknown
  toolName: string | null
  tokenCount: number
  createdAt: number
}

/** 序列化后的终端元信息（热更新后新实例按原 id 重建 shell）。 */
type SerializedTerminal = {
  id: string
  shell: string
  cwd: string
  title: string
  projectId?: string
  /** P3-7：用户勾选「更新后自动重启」的前台命令（如 `npm run dev`）；
   *  新实例重建 shell 后把该命令写入 stdin 重跑。仅显式勾选才携带。 */
  command?: string
}

/** 热更新迁移快照（spec §18.2）。 */
type SessionSnapshot = {
  version: string
  sessions: SerializedSession[]
  entries: SerializedEntry[]
  config: unknown
  timestamp: number
  /** P1：活跃终端元信息——进程无法续命，新实例据此在原位重建 shell（同 id，
   *  前端持久化布局可无感重连）。旧快照缺省视为无终端。 */
  terminals?: SerializedTerminal[]
}

const CURRENT_SNAPSHOT_VERSION = '0.1.0'

function toDateMs(v: unknown): number {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string' || typeof v === 'number') return new Date(v).getTime()
  return Date.now()
}

function toSerializedSession(row: typeof sessions.$inferSelect): SerializedSession {
  return {
    id: row.id,
    title: row.title,
    parentId: row.parentId,
    projectId: row.projectId,
    branchPoint: row.branchPoint,
    metadata: row.metadata,
    agentType: row.agentType,
    worktreePath: row.worktreePath,
    source: row.source,
    deletedAt: row.deletedAt ? toDateMs(row.deletedAt) : null,
    deletedBatchId: row.deletedBatchId ?? null,
    createdAt: toDateMs(row.createdAt),
    updatedAt: toDateMs(row.updatedAt),
  }
}

function toSerializedEntry(row: typeof sessionEntries.$inferSelect): SerializedEntry {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tag: row.tag,
    role: row.role,
    content: row.content,
    toolName: row.toolName,
    tokenCount: row.tokenCount ?? 0,
    createdAt: toDateMs(row.createdAt),
  }
}

/** 从 DB 导出所有会话与条目为可序列化快照。terminals 为活跃终端元信息（可选）。 */
async function serializeSessions(
  handle: DB,
  config?: unknown,
  terminals?: SerializedTerminal[],
): Promise<SessionSnapshot> {
  const [sRows, eRows] = await Promise.all([
    handle.db.select().from(sessions),
    handle.db.select().from(sessionEntries),
  ])
  return {
    version: CURRENT_SNAPSHOT_VERSION,
    sessions: sRows.map(toSerializedSession),
    entries: eRows.map(toSerializedEntry),
    config: config ?? null,
    timestamp: Date.now(),
    ...(terminals && terminals.length > 0 ? { terminals } : {}),
  }
}

/**
 * 把快照导入 DB（保留原始 id 与时间戳），两阶段插入：
 *  1. 全部会话行以 parentId=NULL 插入——任何插入顺序都满足自引用 FK，
 *     无需拓扑排序；
 *  2. 回填各行的 parentId——此时全部行已存在，FK 恒可满足。
 *
 * 此前按拓扑序逐个插入（orderSessionsByParent 先父后子）：环防护只保证
 * 「终止」——parentId 成环（a↔b 互指/自引用）时环上第一个被访问的节点先于
 * 其父入序，插入它即撞自引用 FK 23503（其父行尚不存在），整个恢复抛错、
 * serve 启动失败。两阶段插入对任意形状（环/自引用/正常森林）都成立，
 * 环上节点父指针完整保留；悬空 parentId（快照外引用）在第二阶段撞 FK，
 * 仍是「数据损坏显式失败」而非静默改写。
 */
async function restoreSessions(handle: DB, snapshot: SessionSnapshot): Promise<void> {
  for (const s of snapshot.sessions) {
    await handle.db
      .insert(sessions)
      .values({
        id: s.id,
        title: s.title,
        parentId: null,
        projectId: s.projectId,
        branchPoint: s.branchPoint,
        metadata: s.metadata as Record<string, unknown>,
        agentType: s.agentType,
        worktreePath: s.worktreePath,
        source: s.source,
        deletedAt: s.deletedAt != null ? new Date(s.deletedAt) : null,
        deletedBatchId: s.deletedBatchId ?? null,
        createdAt: new Date(s.createdAt),
        updatedAt: new Date(s.updatedAt),
      })
      .onConflictDoNothing()
  }
  for (const s of snapshot.sessions) {
    if (s.parentId === null) continue
    await handle.db.update(sessions).set({ parentId: s.parentId }).where(eq(sessions.id, s.id))
  }
  for (const e of snapshot.entries) {
    await handle.db
      .insert(sessionEntries)
      .values({
        id: e.id,
        sessionId: e.sessionId,
        tag: e.tag,
        role: e.role,
        content: e.content as Record<string, unknown>,
        toolName: e.toolName,
        tokenCount: e.tokenCount,
        createdAt: new Date(e.createdAt),
      })
      .onConflictDoNothing()
  }
}

export type { SerializedEntry, SerializedSession, SerializedTerminal, SessionSnapshot }
export { restoreSessions, serializeSessions }
