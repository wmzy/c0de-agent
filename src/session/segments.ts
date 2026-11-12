/**
 * LLM 段（metadata.segments）管理：段前缀指纹、旧 metadata.llmDetails 的遗产迁移、
 * 段的读取与全量替换（每轮 loop 结束写入）。会话 CRUD 见 session.ts；删除生命周期见 trash.ts。
 */
import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { sessions } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import type { LLMSegment } from '../shared/types/agent.js'
import type { ChatTool } from '../shared/types/llm.js'
import type { SessionMetadata } from '../shared/types/message.js'
import { updateSessionMetadata } from './session.js'

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
  // 只取 metadata 列——本函数在每轮 loop 结束的段写入路径上高频执行，
  // 不必拖整行（标题/parent/agentType 等）。
  const [row] = await handle.db
    .select({ metadata: sessions.metadata })
    .from(sessions)
    .where(eq(sessions.id, id))
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
  await updateSessionMetadata(
    handle,
    id,
    (meta) => {
      const migrated = migrateLegacyDetails(meta as Record<string, unknown>)
      const { segments: _omit, ...rest } = migrated
      return { ...rest, segments } as SessionMetadata
    },
    { bumpUpdatedAt: true },
  )
}
