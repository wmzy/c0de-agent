import { unlink } from 'node:fs/promises'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createAgent } from '../../core/agent.js'
import { executeWorkflow } from '../../core/workflows/runtime.js'
import { createSession } from '../../session/session.js'
import { autoAllowChecker } from '../../tools/permission.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

/** 创建工作流 REST API 路由。 */
function createWorkflowsRoute(ctx: ServerContext) {
  const app = new Hono()

  // GET / — 列出所有工作流
  app.get('/', (c) => {
    const registry = ctx.workflowRegistry
    if (!registry) {
      return c.json({ workflows: [] })
    }
    const workflows = registry.list().map((entry) => ({
      name: entry.meta.name,
      description: entry.meta.description,
      argsHint: entry.meta.argsHint,
      phases: entry.meta.phases,
      source: entry.source,
    }))
    return c.json({ workflows })
  })

  // GET /:name — 元数据 + 源码
  app.get('/:name', (c) => {
    const name = c.req.param('name')
    const registry = ctx.workflowRegistry
    if (!registry) {
      return apiError(c, 500, 'NOT_INITIALIZED', 'Workflow registry not initialized')
    }
    const entry = registry.get(name)
    if (!entry) {
      return apiError(c, 404, 'NOT_FOUND', `Workflow "${name}" not found`)
    }
    return c.json({
      name: entry.meta.name,
      description: entry.meta.description,
      argsHint: entry.meta.argsHint,
      phases: entry.meta.phases,
      source: entry.source,
      sourceCode: entry.sourceCode,
    })
  })

  // POST /:name/run — 执行工作流（SSE 推送进度）
  app.post('/:name/run', async (c) => {
    const name = c.req.param('name')
    const registry = ctx.workflowRegistry
    if (!registry) {
      return apiError(c, 500, 'NOT_INITIALIZED', 'Workflow registry not initialized')
    }
    const entry = registry.get(name)
    if (!entry) {
      return apiError(c, 404, 'NOT_FOUND', `Workflow "${name}" not found`)
    }

    const body = await c.req.json().catch(() => ({}))
    const args = (body as { args?: string }).args ?? ''

    const agentConfig = {
      provider: ctx.config.defaultProvider,
      model: ctx.config.defaultModel,
      tools: [],
      plugins: ctx.config.plugins.enabled,
      agentName: 'default',
    }
    const session = await createSession(ctx.db, `workflow:${name}`, undefined, 'workflow')
    const parent = await createAgent(session, agentConfig, {
      db: ctx.db,
      llmRegistry: ctx.llmRegistry,
      toolRegistry: ctx.toolRegistry,
      permission: autoAllowChecker,
      config: ctx.config,
      cwd: ctx.cwd,
      agentRegistry: ctx.agentRegistry,
    })

    return streamSSE(c, async (stream) => {
      const deps = {
        db: ctx.db,
        llmRegistry: ctx.llmRegistry,
        toolRegistry: ctx.toolRegistry,
        permission: autoAllowChecker,
        config: ctx.config,
        cwd: ctx.cwd,
        agentRegistry: ctx.agentRegistry,
      }

      try {
        const result = await executeWorkflow({
          registry,
          name,
          args,
          deps,
          parent,
          onProgress: async (message, detail) => {
            await stream.writeSSE({
              event: 'progress',
              data: JSON.stringify({ message, detail }),
            })
          },
        })

        await stream.writeSSE({
          event: 'result',
          data: JSON.stringify(result),
        })
      } catch (e) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            _tag: 'error',
            message: e instanceof Error ? e.message : String(e),
          }),
        })
      }
    })
  })

  // DELETE /:name — 删除（仅非 builtin）
  app.delete('/:name', async (c) => {
    const name = c.req.param('name')

    // 名称格式校验（涉及文件系统操作前阻断路径穿越）
    if (!/^[a-z0-9-]+$/.test(name)) {
      return apiError(c, 400, 'BAD_REQUEST', `Invalid workflow name "${name}"`)
    }

    const registry = ctx.workflowRegistry
    if (!registry) {
      return apiError(c, 500, 'NOT_INITIALIZED', 'Workflow registry not initialized')
    }
    const entry = registry.get(name)
    if (!entry) {
      return apiError(c, 404, 'NOT_FOUND', `Workflow "${name}" not found`)
    }
    if (entry.source === 'builtin') {
      return apiError(c, 400, 'BAD_REQUEST', 'Cannot delete builtin workflow')
    }

    // 先从磁盘删除文件（若存在），失败则告知用户且不清理 registry 以保持状态一致
    if (entry.filePath) {
      try {
        await unlink(entry.filePath)
      } catch {
        return apiError(c, 500, 'DELETE_FAILED', `Failed to delete workflow file for "${name}"`)
      }
    }

    registry.delete(name)
    return c.json({ ok: true })
  })

  return app
}

export { createWorkflowsRoute }
