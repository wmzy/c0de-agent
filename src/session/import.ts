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
  if (typeof value === 'number') {
    // 非有限数值（JSON 1e999 → Infinity）会产出 Invalid Date，时间戳序列化
    // 直接击穿插入事务（整单 500）。与字符串分支同口径：无法解析回退当前时间。
    return Number.isFinite(value) ? new Date(value) : new Date()
  }
  if (typeof value === 'string') {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date()
}

/**
 * 按 MessageContent 判别字段的形状校验每个分片。
 * 此前只校验 `_tag` 是字符串：`{_tag:'text', text:123}` 等类型违规分片原样入库，
 * 后续续聊在 estimateTokens(123) 处 TypeError（历史会话每次对话都 500），
 * 且 token/protocol 层被迫对缺字段形状逐个打补丁。导入是未受信 JSON 的唯一
 * 入库入口——在此收敛：结构违规的分片整体丢弃（宁少勿坏）。
 */
function isWellFormedPart(p: Record<string, unknown>): boolean {
  switch (p._tag) {
    case 'text':
    case 'thinking':
    case 'steering':
      return typeof p.text === 'string'
    case 'tool_call':
      return (
        typeof p.id === 'string' &&
        typeof p.tool === 'string' &&
        (p.input === undefined ||
          (typeof p.input === 'object' && p.input !== null && !Array.isArray(p.input)))
      )
    case 'tool_result':
      return (
        typeof p.id === 'string' &&
        typeof p.tool === 'string' &&
        typeof p.output === 'object' &&
        p.output !== null &&
        !Array.isArray(p.output)
      )
    case 'image':
      return typeof p.mediaType === 'string' && typeof p.data === 'string'
    default:
      // 未知分片类型：丢弃（宁少勿坏）
      return false
  }
}

function sanitizeContent(content: unknown): MessageContent[] {
  if (Array.isArray(content)) {
    // 只保留结构完整的分片；其余丢弃（导入宁少勿坏）
    return content.filter(
      (p): p is MessageContent =>
        p !== null &&
        typeof p === 'object' &&
        !Array.isArray(p) &&
        typeof (p as { _tag?: unknown })._tag === 'string' &&
        isWellFormedPart(p as Record<string, unknown>),
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
        // tokenCount 是 integer 列：非有限数值（JSON 1e999 → Infinity）会击穿
        // 插入事务（整单 500）；非法值收敛为 0（未知）。
        tokenCount:
          typeof m.tokenCount === 'number' && Number.isFinite(m.tokenCount) ? m.tokenCount : 0,
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
        // integer 列：与消息 tokenCount 同口径拒绝非有限数值（JSON 1e999）。
        tokenCount:
          typeof a.tokenCount === 'number' && Number.isFinite(a.tokenCount) ? a.tokenCount : null,
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
