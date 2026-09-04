import { Hono } from 'hono'
import { createSummarizer, runCompaction } from '../../core/compact.js'
import { fromDirectory } from '../../project/index.js'
import { archiveOriginalEntries } from '../../session/archive.js'
import {
  BranchPointOutOfRangeError,
  forkSession,
  getBranches,
  getTree,
} from '../../session/branch.js'
import { deleteEntriesByIds, getMessages, insertEntry } from '../../session/message.js'
import {
  createSession,
  getLLMSegments,
  getSession,
  listDeletedSessions,
  listSessions,
  listSessionsByProject,
  restoreSession,
  softDeleteSession,
  touchLastOpened,
} from '../../session/session.js'
import {
  applyShakeRegions,
  collectShakeRegions,
  DEFAULT_SHAKE_CONFIG,
  toRegionViews,
} from '../../session/shake.js'
import { estimateMessageTokens } from '../../session/token.js'
import { generateId } from '../../shared/index.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

function createSessionRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // 创建会话
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const title = (body.title as string) ?? 'New Session'
    const directory = body.directory as string | undefined
    const explicitProjectId = body.projectId as string | undefined
    let projectId: string | undefined
    if (directory) {
      const project = await fromDirectory(ctx.db, directory)
      projectId = project.id
    } else if (explicitProjectId) {
      projectId = explicitProjectId
    }
    const session = await createSession(ctx.db, title, projectId)
    return c.json(session, 201)
  })

  // 列出会话
  app.get('/', async (c) => {
    const projectId = c.req.query('projectId')
    const sessions = projectId
      ? await listSessionsByProject(ctx.db, projectId)
      : await listSessions(ctx.db)
    return c.json(sessions)
  })

  // 会话树
  app.get('/tree', async (c) => {
    const tree = await getTree(ctx.db)
    return c.json(tree)
  })

  // 回收站：已软删除的会话列表（必须注册在 /:id 之前，避免被参数路由吞掉）
  app.get('/deleted', async (c) => {
    const sessions = await listDeletedSessions(ctx.db)
    return c.json(sessions)
  })

  // 获取会话详情
  app.get('/:id', async (c) => {
    try {
      const session = await getSession(ctx.db, c.req.param('id'))
      if (!session) {
        return apiError(c, 404, 'NOT_FOUND', 'Session not found')
      }
      return c.json(session)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }
  })

  // 分支会话：未指定 messageIndex 时默认在最新一条消息处分叉（fork=完整副本语义）
  app.post('/:id/fork', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    let messageIndex = body.messageIndex as number | undefined
    if (messageIndex === undefined || !Number.isFinite(messageIndex)) {
      const messages = await getMessages(ctx.db, id)
      if (messages.length === 0) {
        return apiError(c, 400, 'EMPTY_SESSION', '空会话无法分支')
      }
      messageIndex = messages.length - 1
    }
    try {
      const forked = await forkSession(ctx.db, id, messageIndex)
      return c.json(forked, 201)
    } catch (error) {
      // 分支点越界是客户端索引/分页 bug → 400 并透出明确语义；归 404 会误导排查
      if (error instanceof BranchPointOutOfRangeError) {
        return apiError(c, 400, 'BRANCH_POINT_OUT_OF_RANGE', error.message)
      }
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }
  })

  // 删除会话（软删除：级联其 fork 后代进入回收站，30 天后物理清除）
  app.delete('/:id', async (c) => {
    const ok = await softDeleteSession(ctx.db, c.req.param('id'))
    if (!ok) return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    return c.body(null, 204)
  })

  // 恢复会话（从回收站还原；仅还原该会话本身）
  app.post('/:id/restore', async (c) => {
    const ok = await restoreSession(ctx.db, c.req.param('id'))
    if (!ok) return apiError(c, 404, 'NOT_FOUND', '会话不存在或未删除')
    return c.json({ ok: true })
  })

  // 获取消息列表
  app.get('/:id/messages', async (c) => {
    const messages = await getMessages(ctx.db, c.req.param('id'))
    return c.json(messages)
  })

  // 获取 LLM 调用分段（段首快照 + 段内轻量 calls）：优先取活跃 run 的内存记录（实时），回退 DB 持久化
  app.get('/:id/llm-details', async (c) => {
    const run = ctx.agentManager.get(c.req.param('id'))
    if (run) return c.json(run.state.segments)
    const persisted = await getLLMSegments(ctx.db, c.req.param('id'))
    return c.json(persisted)
  })

  // 手动触发会话压缩（段切换确认弹窗「顺便压缩」调用）。用末段的 provider/model 构建摘要器。
  app.post('/:id/compact', async (c) => {
    const id = c.req.param('id')
    let session: Awaited<ReturnType<typeof getSession>>
    try {
      session = await getSession(ctx.db, id)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }
    if (!session) return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    const segs = await getLLMSegments(ctx.db, id)
    const lastSeg = segs[segs.length - 1]
    const provider = lastSeg?.provider ?? ctx.config.defaultProvider
    const model = lastSeg?.model ?? ctx.config.defaultModel
    try {
      const summarizer = createSummarizer(ctx.llmRegistry, provider, model, {})
      const result = await runCompaction(ctx.db, id, summarizer, {
        keepRecentTokens: ctx.config.compaction.keepRecentTokens,
      })
      return c.json(result)
    } catch (e) {
      return apiError(
        c,
        500,
        'COMPACTION_FAILED',
        e instanceof Error ? e.message : 'Compaction failed',
      )
    }
  })

  // 获取会话状态：内存有活跃 run → 返回其 status；否则查 DB lastRun。
  // lastRun.status='running' 且无活跃 run → 服务重启被中断。
  // lastRun.status='paused' 但无活跃 run（热更新/重启后 run 状态未迁移）→ 同样按中断处理：
  // agent 内存态已丢失，resume 端点无法恢复，唯一可行路径是重发上一条消息。
  app.get('/:id/status', async (c) => {
    const run = ctx.agentManager.get(c.req.param('id'))
    if (run) return c.json(run.state.status)
    const session = await getSession(ctx.db, c.req.param('id'))
    if (
      session?.metadata.lastRun?.status === 'running' ||
      session?.metadata.lastRun?.status === 'paused'
    ) {
      return c.json({ _tag: 'interrupted' })
    }
    return c.json({ _tag: 'idle' })
  })

  // shake preview：返回可 shake 的区域列表
  app.post('/:id/shake/preview', async (c) => {
    const id = c.req.param('id')
    let session: Awaited<ReturnType<typeof getSession>>
    try {
      session = await getSession(ctx.db, id)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }
    if (!session) return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    const messages = await getMessages(ctx.db, id)
    // Manual shake: show ALL candidates (protectTokens=0, minSavings=0).
    // toRegionViews still marks isAfterProtectWindow using the real config.
    const manualConfig = { ...DEFAULT_SHAKE_CONFIG, protectTokens: 0, minSavings: 0 }
    const regions = collectShakeRegions(messages, manualConfig)
    const views = toRegionViews(regions, DEFAULT_SHAKE_CONFIG, messages)
    return c.json({ regions: views })
  })

  // shake apply：归档原始内容 + 原位替换
  app.post('/:id/shake/apply', async (c) => {
    const id = c.req.param('id')
    let session: Awaited<ReturnType<typeof getSession>>
    try {
      session = await getSession(ctx.db, id)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }
    if (!session) return apiError(c, 404, 'NOT_FOUND', 'Session not found')

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const regionIds = (body.regionIds as string[] | undefined) ?? []

    const messages = await getMessages(ctx.db, id)
    const manualConfig = { ...DEFAULT_SHAKE_CONFIG, protectTokens: 0, minSavings: 0 }
    const regions = collectShakeRegions(messages, manualConfig)

    // 校验：所有 regionIds 必须命中当前 preview 结果（原子性）
    const availableIds = new Set(regions.map((r) => r.id))
    const unknownIds = regionIds.filter((rid) => !availableIds.has(rid))
    if (unknownIds.length > 0) {
      return apiError(c, 400, 'INVALID_REGIONS', '消息已变化，请重新预览')
    }

    const selectedSet = new Set(regionIds)
    const selected = regions.filter((r) => selectedSet.has(r.id))
    if (selected.length === 0) {
      return c.json({ shaken: 0, archiveId: '' })
    }

    const affectedIds = [...new Set(selected.map((r) => r.messageId))]
    const originalMessages = messages.filter((m) => affectedIds.includes(m.id))

    const archiveId = generateId()
    const totalTokens = selected.reduce((sum, r) => sum + r.tokens, 0)
    await archiveOriginalEntries(
      ctx.db,
      id,
      originalMessages,
      'shake',
      `Shaken ${selected.length} regions, saved ${totalTokens} tokens`,
      archiveId,
    )

    const shakenMessages = applyShakeRegions(messages, selected)

    await deleteEntriesByIds(ctx.db, affectedIds)
    for (const msg of shakenMessages) {
      if (!affectedIds.includes(msg.id)) continue
      await insertEntry(ctx.db, {
        id: msg.id,
        sessionId: id,
        tag: 'message',
        role: msg.role,
        content: msg.content,
        tokenCount: estimateMessageTokens(msg.content),
        createdAt: new Date(msg.createdAt),
      })
    }

    return c.json({ shaken: selected.length, archiveId })
  })

  // 记录会话打开（更新 metadata.lastOpenedAt，用于会话列表按最近打开排序）
  app.post('/:id/open', async (c) => {
    await touchLastOpened(ctx.db, c.req.param('id'))
    return c.json({ ok: true })
  })

  // 获取分支
  app.get('/:id/branches', async (c) => {
    const branches = await getBranches(ctx.db, c.req.param('id'))
    return c.json(branches)
  })

  return app
}

export { createSessionRoute }
