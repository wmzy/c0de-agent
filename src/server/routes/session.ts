import { existsSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createSummarizer, runCompaction } from '../../core/compact.js'
import { loadConfigScopes, mergeConfig } from '../../core/config.js'
import { sessions } from '../../db/schema.js'
import { fromDirectory } from '../../project/index.js'
import { getProject } from '../../project/project.js'
import { archiveOriginalEntries, listArchives } from '../../session/archive.js'
import {
  BranchPointOutOfRangeError,
  forkSession,
  getBranches,
  getTree,
} from '../../session/branch.js'
import { importSessionData } from '../../session/import.js'
import { deleteEntriesByIds, getMessages, insertEntry } from '../../session/message.js'
import {
  createSession,
  emptyTrash,
  getLLMSegments,
  getSession,
  listDeletedSessions,
  listOrphanDeletedSessions,
  listSessions,
  listSessionsByProject,
  permanentlyDeleteSession,
  rebindSession,
  restoreSessionCore,
  searchSessions,
  softDeleteSession,
  touchLastOpened,
  touchTrashSeen,
  updateSessionTitle,
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
import { buildRegistryFromConfig } from '../registry-config.js'
import type { ServerContext } from '../types.js'
import { resolveAgentCwd } from './chat.js'

function createSessionRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // 会话导入：GET /:id/export 的逆操作（数据备份/迁移闭环）。
  // 消息/归档重新生成 id（保留内容与时间戳），同库复制、重复导入均安全。
  // 绑定 projectId 后立即出现在对应项目视图。
  // P1-2：projectId 必填——无归属会话在任何项目视图都不可见，导入即孤儿。
  app.post('/import', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      version?: unknown
      session?: { title?: unknown; parentId?: unknown; metadata?: unknown } | null
      messages?: unknown
      archives?: unknown
      projectId?: unknown
    } | null
    if (body?.version !== 1 || !body?.session || !Array.isArray(body?.messages)) {
      return apiError(
        c,
        400,
        'INVALID_EXPORT',
        '无效的会话导出 JSON：需要 version/session/messages 字段',
      )
    }
    const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : ''
    if (!projectId) {
      return apiError(c, 400, 'PROJECT_REQUIRED', '导入会话必须指定目标项目（projectId）')
    }
    const project = await getProject(ctx.db, projectId)
    if (!project) {
      return apiError(c, 404, 'PROJECT_NOT_FOUND', '目标项目不存在')
    }
    const title =
      typeof body.session.title === 'string' && body.session.title
        ? body.session.title
        : '导入的会话'
    // P2：导出会话的权限态（permissionMode/alwaysAllow）随迁，仅取安全白名单字段。
    const metadata: Record<string, unknown> = {}
    const srcMeta = body.session.metadata
    if (srcMeta && typeof srcMeta === 'object' && !Array.isArray(srcMeta)) {
      const m = srcMeta as Record<string, unknown>
      if (m.permissionMode === 'auto' || m.permissionMode === 'default') {
        metadata.permissionMode = m.permissionMode
      }
      if (Array.isArray(m.alwaysAllow)) {
        metadata.alwaysAllow = m.alwaysAllow.filter((x): x is string => typeof x === 'string')
      }
    }
    // P2：导出含分支树结构（parentId），导入为独立根会话——告知前端提示扁平化。
    const flattened = typeof body.session.parentId === 'string' && body.session.parentId.length > 0
    const result = await importSessionData(ctx.db, {
      title,
      projectId,
      messages: body.messages as Parameters<typeof importSessionData>[1]['messages'],
      archives: Array.isArray(body.archives)
        ? (body.archives as Parameters<typeof importSessionData>[1]['archives'])
        : [],
      metadata,
    })
    return c.json({ ok: true, ...result, flattened })
  })

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

  // 跨会话搜索（P2-6）：标题 + 消息内容匹配；?q= 关键词，?projectId= 限定项目。
  // P3：?includeDeleted=1 搜索回收站（配合回收站搜索框）。
  // 注册在 /:id 之前避免被参数路由吞掉。
  app.get('/search', async (c) => {
    const q = c.req.query('q') ?? ''
    const projectId = c.req.query('projectId')
    const includeDeleted =
      c.req.query('includeDeleted') === '1' || c.req.query('includeDeleted') === 'true'
    if (!q.trim()) return c.json({ results: [] })
    const results = await searchSessions(ctx.db, q, projectId, { includeDeleted })
    return c.json({ results })
  })

  // 回收站：已软删除的会话列表（必须注册在 /:id 之前，避免被参数路由吞掉）。
  // ?projectId= 过滤本项目（P1-7：回收站此前全库共享，跨项目可见可清空）。
  // ?orphan=1 → 仅列出未归属项目的已删会话（删除项目后 FK set null 导致的孤儿，F1）。
  app.get('/deleted', async (c) => {
    const projectId = c.req.query('projectId')
    if (c.req.query('orphan') === '1') {
      await touchTrashSeen(ctx.db, { orphan: true })
      return c.json(await listOrphanDeletedSessions(ctx.db))
    }
    await touchTrashSeen(ctx.db, projectId ? { projectId } : {})
    const sessions = await listDeletedSessions(ctx.db, projectId)
    return c.json(sessions)
  })

  // 清空回收站：物理删除所有软删除会话（不可恢复）。?projectId= 仅清空该项目。
  app.delete('/deleted', async (c) => {
    const projectId = c.req.query('projectId')
    const count = await emptyTrash(ctx.db, projectId)
    return c.json({ ok: true, deleted: count })
  })

  // 获取会话详情
  app.get('/:id', async (c) => {
    try {
      const session = await getSession(ctx.db, c.req.param('id'))
      if (!session || session.deletedAt) {
        return apiError(c, 404, 'NOT_FOUND', '会话不存在或已删除')
      }
      return c.json(session)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }
  })

  // P2-5：会话重命名（此前标题只能由 LLM 自动生成，用户无法修改）
  app.patch('/:id', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown }
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) return apiError(c, 400, 'BAD_REQUEST', 'title is required')
    if (title.length > 120) {
      return apiError(c, 400, 'BAD_REQUEST', 'title must be at most 120 characters')
    }
    const session = await getSession(ctx.db, id)
    if (!session) return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    await updateSessionTitle(ctx.db, id, title)
    return c.json({ ok: true, title })
  })

  // 分支会话：未指定 messageIndex 时默认在最新一条消息处分叉（fork=完整副本语义）
  app.post('/:id/fork', async (c) => {
    const id = c.req.param('id')
    // P3：fork 复制消息树，与正在写库的活跃 run 存在竞态——先拒绝。
    if (ctx.agentManager.get(id)) {
      return apiError(c, 409, 'RUN_ACTIVE', '该会话已有进行中的对话，请等待完成或中止后再分支')
    }
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

  // 删除会话（软删除：级联其 fork 后代进入回收站，30 天后物理清除）。
  // P2 修复：删除运行中的会话前先中止其活跃 run（含子 agent）——
  // 否则 run 继续向已删除会话写入消息，用户以为已删除而 agent 仍在执行。
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    ctx.agentManager.abort(id)
    for (const child of ctx.agentManager.children(id)) {
      ctx.agentManager.abort(child.sessionId)
    }
    const ok = await softDeleteSession(ctx.db, id)
    if (!ok) return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    return c.body(null, 204)
  })

  // 彻底删除回收站会话（不可恢复）：会话 + 全部后代物理清除
  app.delete('/:id/forever', async (c) => {
    let count: number
    try {
      count = await permanentlyDeleteSession(ctx.db, c.req.param('id'))
    } catch {
      return apiError(c, 404, 'NOT_FOUND', '会话不存在或不在回收站')
    }
    if (count === 0) return apiError(c, 404, 'NOT_FOUND', '会话不存在或不在回收站')
    return c.json({ ok: true, deleted: count })
  })

  // 会话归档列表（compaction/squash/shake/clear 的原始内容）；?q= 搜索归档文本
  app.get('/:id/archives', async (c) => {
    const id = c.req.param('id')
    let session: Awaited<ReturnType<typeof getSession>>
    try {
      session = await getSession(ctx.db, id)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }
    if (!session) return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    const q = c.req.query('q')
    const archives = await listArchives(ctx.db, id, q)
    return c.json({ archives })
  })

  // 会话导出：元数据 + 消息 + 全部归档（JSON 下载，数据可迁移）
  app.get('/:id/export', async (c) => {
    const id = c.req.param('id')
    let session: Awaited<ReturnType<typeof getSession>>
    try {
      session = await getSession(ctx.db, id)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }
    if (!session) return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    const messages = await getMessages(ctx.db, id)
    const archives = await listArchives(ctx.db, id)
    return c.json({
      version: 1,
      exportedAt: new Date().toISOString(),
      session,
      messages,
      archives,
    })
  })

  // 恢复会话（从回收站还原；仅还原该会话本身）。
  // P1 可达性修复：会话所属项目已被删除时（FK set null），按 worktreePath 重建
  // 项目记录并重新归属——否则恢复成功但会话不属于任何项目视图，UI 不可达。
  // P1-2：body.projectId 提供时（当前项目视图），目录失效无法重建归属的孤儿
  // 会话直接归属到该请求项目，恢复即可达。
  app.post('/:id/restore', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { projectId?: unknown }
    const requestProjectId =
      typeof body.projectId === 'string' && body.projectId ? body.projectId : undefined
    const result = await restoreSessionCore(ctx.db, id)
    if (!result.restored) return apiError(c, 404, 'NOT_FOUND', '会话不存在或未删除')
    const session = await getSession(ctx.db, id)
    let rebound = false
    let orphaned = false
    if (session && !session.projectId) {
      const wt = session.worktreePath
      if (wt && existsSync(wt)) {
        try {
          const project = await fromDirectory(ctx.db, wt)
          await ctx.db.db.update(sessions).set({ projectId: project.id }).where(eq(sessions.id, id))
          rebound = true
        } catch {
          orphaned = true
        }
      } else {
        orphaned = true
      }
      // P1-2：目录失效且请求方提供了项目上下文 → 归属到该请求项目
      if (orphaned && requestProjectId) {
        const project = await getProject(ctx.db, requestProjectId)
        if (project) {
          await rebindSession(ctx.db, id, project)
          orphaned = false
          rebound = true
        }
      }
    }
    return c.json({
      ok: true,
      rebound,
      orphaned,
      restoredAncestorCount: result.restoredAncestorCount,
      crossedBatchAncestor: result.crossedBatchAncestor,
    })
  })

  // 会话归属变更（P1-2）：孤儿会话归属到指定项目，恢复后即可达。
  app.post('/:id/rebind', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { projectId?: unknown }
    const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : ''
    if (!projectId) return apiError(c, 400, 'PROJECT_REQUIRED', 'projectId is required')
    const project = await getProject(ctx.db, projectId)
    if (!project) return apiError(c, 404, 'PROJECT_NOT_FOUND', '目标项目不存在')
    const ok = await rebindSession(ctx.db, id, project)
    if (!ok) return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    return c.json({ ok: true, projectId: project.id })
  })

  // 获取消息列表
  app.get('/:id/messages', async (c) => {
    const id = c.req.param('id')
    const session = await getSession(ctx.db, id)
    if (!session || session.deletedAt) {
      return apiError(c, 404, 'NOT_FOUND', '会话不存在或已删除')
    }
    const messages = await getMessages(ctx.db, id)
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
  // P1 多项目：keepRecentTokens 按会话项目配置解析（此前用启动目录配置）。
  app.post('/:id/compact', async (c) => {
    const id = c.req.param('id')
    // P3：压缩改写消息树，与活跃 run 的并发写入存在竞态——先拒绝。
    if (ctx.agentManager.get(id)) {
      return apiError(c, 409, 'RUN_ACTIVE', '该会话已有进行中的对话，请等待完成或中止后再压缩')
    }
    let session: Awaited<ReturnType<typeof getSession>>
    try {
      session = await getSession(ctx.db, id)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }
    if (!session) return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    let sessionConfig = ctx.config
    let sessionRegistry = ctx.llmRegistry
    try {
      const sessionCwd = await resolveAgentCwd(ctx, session)
      if (sessionCwd !== ctx.cwd) {
        const projectScope = loadConfigScopes(sessionCwd).project
        if (projectScope) {
          sessionConfig = mergeConfig(ctx.config, projectScope)
          // P1-1：压缩摘要同样需要项目级 provider 注册表。
          if (sessionConfig.providers.length > 0) {
            sessionRegistry = buildRegistryFromConfig(sessionConfig)
          }
        }
      }
    } catch {
      // cwd 解析失败不阻塞压缩：回退服务级配置（压缩优于报错）
    }
    const segs = await getLLMSegments(ctx.db, id)
    const lastSeg = segs[segs.length - 1]
    const provider = lastSeg?.provider ?? sessionConfig.defaultProvider
    const model = lastSeg?.model ?? sessionConfig.defaultModel
    try {
      const summarizer = createSummarizer(sessionRegistry, provider, model, {})
      const result = await runCompaction(ctx.db, id, summarizer, {
        keepRecentTokens: sessionConfig.compaction.keepRecentTokens,
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
    // P3：shake 原位改写消息，与活跃 run 的并发写入存在竞态——先拒绝。
    if (ctx.agentManager.get(id)) {
      return apiError(c, 409, 'RUN_ACTIVE', '该会话已有进行中的对话，请等待完成或中止后再 Shake')
    }
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
