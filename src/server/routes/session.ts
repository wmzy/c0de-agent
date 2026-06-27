import { Hono } from 'hono'
import { forkSession, getBranches, getTree } from '../../session/branch.js'
import { getMessages } from '../../session/message.js'
import { createSession, deleteSession, getSession, listSessions } from '../../session/session.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

function createSessionRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // 创建会话
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const title = (body.title as string) ?? 'New Session'
    const session = await createSession(ctx.db, title)
    return c.json(session, 201)
  })

  // 列出会话
  app.get('/', async (c) => {
    const sessions = await listSessions(ctx.db)
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

  // 获取 LLM 调用详情
  app.get('/:id/llm-details', async (c) => {
    const run = ctx.agentManager.get(c.req.param('id'))
    return c.json(run?.state.llmDetails ?? [])
  })

  // 获取分支
  app.get('/:id/branches', async (c) => {
    const branches = await getBranches(ctx.db, c.req.param('id'))
    return c.json(branches)
  })

  return app
}

export { createSessionRoute }
