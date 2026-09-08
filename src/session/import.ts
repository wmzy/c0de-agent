import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { compactionArchives, sessionEntries, sessions } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import type { MessageRole } from '../shared/types/base.js'
import type { MessageContent } from '../shared/types/message.js'
import { createSession } from './session.js'

/** 导入消息的宽松形状（导出 JSON 反序列化后，字段可能缺失/类型漂移）。 */
type ImportMessage = {
  id?: string
  role?: string
  content?: unknown
  tokenCount?: number
  createdAt?: number | string
}

/** 导入归档的宽松形状。 */
type ImportArchive = {
  id?: string
  compactionId?: string
  archiveType?: string
  originalEntries?: unknown
  fileSnapshots?: unknown
  summary?: string
  tokenCount?: number
  searchableText?: string
  createdAt?: number | string
}

const VALID_ROLES: ReadonlySet<string> = new Set<MessageRole>([
  'user',
  'assistant',
  'system',
  'tool',
])

function toDate(value: number | string | undefined): Date {
  if (typeof value === 'number') return new Date(value)
  if (typeof value === 'string') {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date()
}

function sanitizeContent(content: unknown): MessageContent[] {
  if (Array.isArray(content)) {
    // 只保留结构完整的分片；其余丢弃（导入宁少勿坏）
    return content.filter(
      (p): p is MessageContent =>
        p !== null && typeof p === 'object' && typeof (p as { _tag?: unknown })._tag === 'string',
    )
  }
  if (typeof content === 'string' && content.length > 0) {
    return [{ _tag: 'text', text: content }]
  }
  return []
}

/**
 * 导入会话数据（GET /sessions/:id/export 的逆操作）：
 * 新建根会话（source 'web'），消息与归档**始终生成新 id**（保留 role/content/时间戳）——
 * 导入副本可重复执行（同库内复制/恢复场景），不与原会话或既往导入冲突。
 * 说明：导出仅含 tag='message' 的消息——compaction/steering 等特殊条目不随迁，
 * 导入后会话显示完整原始消息流（上下文重建略长，但不丢内容）。
 * P0：权限态（permissionMode/alwaysAllow）仅在调用方显式确认后随迁——
 * metadata 由路由层过滤，未确认时不传入本函数。
 */
async function importSessionData(
  handle: DB,
  opts: {
    title: string
    projectId?: string
    messages: ImportMessage[]
    archives: ImportArchive[]
    /** 随迁的会话 metadata（仅权限态等安全字段，由调用方过滤）。 */
    metadata?: Record<string, unknown>
  },
): Promise<{ sessionId: string; messageCount: number; archiveCount: number }> {
  const session = await createSession(handle, opts.title, opts.projectId, undefined, 'web')
  return handle.db.transaction(async (tx) => {
    if (opts.metadata && Object.keys(opts.metadata).length > 0) {
      await tx.update(sessions).set({ metadata: opts.metadata }).where(eq(sessions.id, session.id))
    }
    let messageCount = 0
    for (const m of opts.messages) {
      const role = m.role
      if (typeof role !== 'string' || !VALID_ROLES.has(role)) continue
      await tx.insert(sessionEntries).values({
        id: generateId(),
        sessionId: session.id,
        tag: 'message',
        role,
        content: sanitizeContent(m.content),
        tokenCount: typeof m.tokenCount === 'number' ? m.tokenCount : 0,
        createdAt: toDate(m.createdAt),
      })
      messageCount += 1
    }
    let archiveCount = 0
    for (const a of opts.archives) {
      await tx.insert(compactionArchives).values({
        id: generateId(),
        sessionId: session.id,
        compactionId:
          typeof a.compactionId === 'string' && a.compactionId.length > 0
            ? a.compactionId
            : generateId(),
        archiveType: typeof a.archiveType === 'string' ? a.archiveType : 'compaction',
        originalEntries: Array.isArray(a.originalEntries) ? a.originalEntries : [],
        fileSnapshots: Array.isArray(a.fileSnapshots) ? a.fileSnapshots : [],
        summary: typeof a.summary === 'string' ? a.summary : '',
        tokenCount: typeof a.tokenCount === 'number' ? a.tokenCount : null,
        searchableText: typeof a.searchableText === 'string' ? a.searchableText : null,
        createdAt: toDate(a.createdAt),
      })
      archiveCount += 1
    }
    return { sessionId: session.id, messageCount, archiveCount }
  })
}

export type { ImportArchive, ImportMessage }
export { importSessionData }
