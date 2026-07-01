import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { sessions } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import type { LLMSegment } from '../shared/types/agent.js'
import type { ChatTool } from '../shared/types/llm.js'
import type { Session, SessionMetadata } from '../shared/types/message.js'

/** Convert a DB row (with Date timestamps) to the shared Session type (with number timestamps). */
export function rowToSession(row: typeof sessions.$inferSelect): Session {
  const created =
    row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime()
  const updated =
    row.updatedAt instanceof Date ? row.updatedAt.getTime() : new Date(row.updatedAt).getTime()
  return {
    id: row.id,
    title: row.title,
    parentId: row.parentId,
    projectId: row.projectId,
    branchPoint: row.branchPoint,
    metadata: (row.metadata ?? {}) as SessionMetadata,
    agentType: row.agentType ?? null,
    worktreePath: row.worktreePath ?? null,
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
): Promise<Session> {
  const [row] = await handle.db
    .insert(sessions)
    .values({ title, projectId: projectId ?? null, agentType: agentType ?? null })
    .returning()
  if (!row) throw new Error('Failed to insert session')
  return rowToSession(row)
}

/** Get a session by id, or null if not found. */
async function getSession(handle: DB, id: string): Promise<Session | null> {
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  return row ? rowToSession(row) : null
}

/** List all sessions. */
async function listSessions(handle: DB): Promise<Session[]> {
  const rows = await handle.db.select().from(sessions)
  return rows.map(rowToSession)
}

/** Delete a session (cascades to entries, archives, snapshots via FK). */
async function deleteSession(handle: DB, id: string): Promise<void> {
  await handle.db.delete(sessions).where(eq(sessions.id, id))
}

/** Update a session's title. */
async function updateSessionTitle(handle: DB, id: string, title: string): Promise<void> {
  await handle.db.update(sessions).set({ title, updatedAt: new Date() }).where(eq(sessions.id, id))
}

/** Bump updatedAt to now (used after appending messages). */
async function touchSession(handle: DB, id: string): Promise<void> {
  await handle.db.update(sessions).set({ updatedAt: new Date() }).where(eq(sessions.id, id))
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

async function listSessionsByProject(handle: DB, projectId: string): Promise<Session[]> {
  const rows = await handle.db.select().from(sessions).where(eq(sessions.projectId, projectId))
  return rows.map(rowToSession)
}

export {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  listSessionsByProject,
  touchSession,
  updateSessionTitle,
}
