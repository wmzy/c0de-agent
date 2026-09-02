import { unlink } from 'node:fs/promises'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createAgent } from '../../core/agent.js'
import { discoverWorkflows, saveWorkflow } from '../../core/workflows/discovery.js'
import { reloadRegistry } from '../../core/workflows/registry.js'
import { executeWorkflow } from '../../core/workflows/runtime.js'
import type { WorkflowEntry } from '../../core/workflows/types.js'
import { getProject } from '../../project/project.js'
import { createSession } from '../../session/session.js'
import { autoAllowChecker } from '../../tools/permission.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

/** 创建工作流 REST API 路由。 */
function createWorkflowsRoute(ctx: ServerContext) {
  const app = new Hono()

  // GET / — 列出所有工作流。可选 ?projectId=xxx 合并项目级 .c0de/workflows/*.js。
  app.get('/', async (c) => {
    const registry = ctx.workflowRegistry
    if (!registry) {
      return c.json({ workflows: [] })
    }

    // 注册表已有 builtin + global + server-cwd；以 name 为 key 去重。
    const byName = new Map<string, WorkflowEntry>()
    for (const entry of registry.list()) {
      byName.set(entry.meta.name, entry)
    }

    // 项目级工作流：从 project.worktree/.c0de/workflows/ 动态发现，同名覆盖。
    const projectId = c.req.query('projectId')
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (project) {
        const projectWorkflows = await discoverWorkflows(project.worktree)
        for (const wf of projectWorkflows) {
          byName.set(wf.meta.name, wf)
        }
      }
    }

    const workflows = Array.from(byName.values()).map((entry) => ({
      name: entry.meta.name,
      description: entry.meta.description,
      argsHint: entry.meta.argsHint,
      phases: entry.meta.phases,
      source: entry.source,
    }))
    return c.json({ workflows })
  })

  // POST / — 创建/保存工作流（写入 .c0de/workflows/<name>.js，验证后热重载注册表）
  app.post('/', async (c) => {
    const registry = ctx.workflowRegistry
    if (!registry) {
      return apiError(c, 500, 'NOT_INITIALIZED', 'Workflow registry not initialized')
    }

    const body = await c.req.json().catch(() => ({}))
    const { name, source, target } = body as {
      name?: string
      source?: string
      target?: 'project' | 'user'
    }

    if (!name || typeof name !== 'string') {
      return apiError(c, 400, 'BAD_REQUEST', 'Missing required field: name')
    }
    if (!source || typeof source !== 'string') {
      return apiError(c, 400, 'BAD_REQUEST', 'Missing required field: source')
    }

    // 保存到磁盘 + dynamic import 验证
    const result = await saveWorkflow(name, source, target ?? 'project', ctx.cwd)
    if (!result.ok) {
      return apiError(c, 400, 'SAVE_FAILED', result.error)
    }

    // 热重载注册表（清空 → 三级重新发现）
    await reloadRegistry(registry, ctx.cwd)

    const entry = registry.get(name)
    return c.json({
      ok: true,
      name: result.meta.name,
      description: result.meta.description,
      filePath: result.filePath,
      phases: entry?.meta.phases,
      source: entry?.source ?? 'project',
    })
  })

  // GET /:name — 元数据 + 源码。可选 ?projectId=xxx 查找项目级工作流。
  app.get('/:name', async (c) => {
    const name = c.req.param('name')
    const registry = ctx.workflowRegistry
    if (!registry) {
      return apiError(c, 500, 'NOT_INITIALIZED', 'Workflow registry not initialized')
    }
    let entry = registry.get(name)

    // 项目级 fallback
    if (!entry) {
      const projectId = c.req.query('projectId')
      if (projectId) {
        const project = await getProject(ctx.db, projectId)
        if (project) {
          const discovered = await discoverWorkflows(project.worktree)
          entry = discovered.find((w) => w.meta.name === name)
        }
      }
    }

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

  // POST /:name/run — 执行工作流（SSE 推送进度）。可选 ?projectId=xxx 执行项目级工作流。
  app.post('/:name/run', async (c) => {
    const name = c.req.param('name')
    const registry = ctx.workflowRegistry
    if (!registry) {
      return apiError(c, 500, 'NOT_INITIALIZED', 'Workflow registry not initialized')
    }
    let entry = registry.get(name)

    // 项目级 fallback + 解析项目 worktree 作为 agent cwd
    let agentCwd = ctx.cwd
    const projectId = c.req.query('projectId')
    if (!entry && projectId) {
      const project = await getProject(ctx.db, projectId)
      if (project) {
        agentCwd = project.worktree
        const discovered = await discoverWorkflows(project.worktree)
        entry = discovered.find((w) => w.meta.name === name)
      }
    }

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
      cwd: agentCwd,
      agentRegistry: ctx.agentRegistry,
    })

    return streamSSE(c, async (stream) => {
      const deps = {
        db: ctx.db,
        llmRegistry: ctx.llmRegistry,
        toolRegistry: ctx.toolRegistry,
        permission: autoAllowChecker,
        config: ctx.config,
        cwd: agentCwd,
        agentRegistry: ctx.agentRegistry,
      }

      try {
        const result = await executeWorkflow({
          registry,
          name,
          entry,
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
