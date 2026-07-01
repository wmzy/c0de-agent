import { Hono } from 'hono'
import { createSummarizer, runCompaction } from '../../core/compact.js'
import { fromDirectory } from '../../project/index.js'
import { forkSession, getBranches, getTree } from '../../session/branch.js'
import { getMessages } from '../../session/message.js'
import {
  createSession,
  deleteSession,
  getLLMSegments,
  getSession,
  listSessions,
  listSessionsByProject,
} from '../../session/session.js'
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

  // 分支会话
  app.post('/:id/fork', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const messageIndex = (body.messageIndex as number) ?? 0
    try {
      const forked = await forkSession(ctx.db, id, messageIndex)
      return c.json(forked, 201)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }
  })

  // 删除会话
  app.delete('/:id', async (c) => {
    await deleteSession(ctx.db, c.req.param('id'))
    return c.body(null, 204)
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
  // lastRun.status='running' 但无活跃 run → 服务重启被中断。
  app.get('/:id/status', async (c) => {
    const run = ctx.agentManager.get(c.req.param('id'))
    if (run) return c.json(run.state.status)
    const session = await getSession(ctx.db, c.req.param('id'))
    if (session?.metadata.lastRun?.status === 'running') {
      return c.json({ _tag: 'interrupted' })
    }
    return c.json({ _tag: 'idle' })
  })

  // 获取分支
  app.get('/:id/branches', async (c) => {
    const branches = await getBranches(ctx.db, c.req.param('id'))
    return c.json(branches)
  })

  return app
}

export { createSessionRoute }
