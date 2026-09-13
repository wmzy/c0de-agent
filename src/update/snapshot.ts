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

/** 按 parentId 拓扑序排列 sessions，使父会话先于子会话插入（满足自引用 FK）。 */
function orderSessionsByParent(list: SerializedSession[]): SerializedSession[] {
  const byId = new Map(list.map((s) => [s.id, s]))
  const ordered: SerializedSession[] = []
  const seen = new Set<string>()
  const visit = (s: SerializedSession): void => {
    if (seen.has(s.id)) return
    const parent = s.parentId ? byId.get(s.parentId) : undefined
    if (parent && !seen.has(parent.id)) visit(parent)
    seen.add(s.id)
    ordered.push(s)
  }
  for (const s of list) visit(s)
  return ordered
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

/** 把快照导入 DB（保留原始 id 与时间戳；父会话先插入以满足 FK）。 */
async function restoreSessions(handle: DB, snapshot: SessionSnapshot): Promise<void> {
  for (const s of orderSessionsByParent(snapshot.sessions)) {
    await handle.db
      .insert(sessions)
      .values({
        id: s.id,
        title: s.title,
        parentId: s.parentId,
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
export { orderSessionsByParent, restoreSessions, serializeSessions }
