import { unlink } from 'node:fs/promises'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createAgent } from '../../core/agent.js'
import { loadConfigScopes, mergeConfig } from '../../core/config.js'
import { discoverWorkflows, saveWorkflow } from '../../core/workflows/discovery.js'
import { reloadRegistry } from '../../core/workflows/registry.js'
import { executeWorkflow } from '../../core/workflows/runtime.js'
import type { WorkflowEntry, WorkflowSource } from '../../core/workflows/types.js'
import { getByDirectory, getProject, trustProject } from '../../project/project.js'
import {
  enrichProjectRiskWithGlobal,
  projectTrustCurrent,
  projectTrustNeeded,
} from '../../project/trust.js'
import { createSession } from '../../session/session.js'
import { apiError } from '../middleware/error.js'
import { createInteractivePermissionChecker } from '../permission/interactive.js'
import { buildRegistryFromConfig } from '../registry-config.js'
import type { ServerContext } from '../types.js'
import { startHeartbeat } from './chat.js'

/** 权限确认超时兜底拒绝后暂停 run 的暂停原因（与 chat 路由同口径）。 */
const PERMISSION_TIMEOUT_PAUSE_REASON =
  '权限确认超时：该工具已被自动拒绝，工作流已暂停。点击「恢复」后可直接要求 agent 重试该工具'

/** 项目级工作流是仓库自带的任意代码执行面（dynamic import 即执行），发现前
 *  必须校验信任状态——与 .c0de/plugins 的加载门禁同口径（trustedAt + 指纹）。 */
async function projectTrustState(ctx: ServerContext, projectId: string) {
  const project = await getProject(ctx.db, projectId)
  if (!project) return { project: null, trusted: false }
  const trusted =
    project.trustedAt != null &&
    projectTrustCurrent(
      loadConfigScopes(project.worktree).project,
      project.trustedAt,
      project.riskFingerprint,
      project.worktree,
    )
  return { project, trusted }
}

/** serve 启动目录项目的信任状态（POST create 后热重载注册表时用）。 */
async function serveCwdTrusted(ctx: ServerContext): Promise<boolean> {
  try {
    const p = await getByDirectory(ctx.db, ctx.cwd)
    if (p?.trustedAt == null) return false
    return projectTrustCurrent(
      loadConfigScopes(ctx.cwd).project,
      p.trustedAt,
      p.riskFingerprint,
      ctx.cwd,
    )
  } catch {
    return false
  }
}

/** 创建工作流 REST API 路由。 */
function createWorkflowsRoute(ctx: ServerContext) {
  const app = new Hono()

  // GET / — 列出所有工作流。可选 ?projectId=xxx 合并项目级 .c0de/workflows/*.js。
  // P0 信任边界：未信任（或信任后漂移）的项目绝不 dynamic import 其工作流文件。
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
    // 记录被覆盖的来源层级（project > user > builtin），前端据此展示「覆盖内置」徽标。
    const overrides = new Map<string, WorkflowSource>()
    const projectId = c.req.query('projectId')
    let trustRequired = false
    if (projectId) {
      const { project, trusted } = await projectTrustState(ctx, projectId)
      if (project && !trusted) {
        trustRequired = true
      } else if (project && trusted) {
        const projectWorkflows = await discoverWorkflows(project.worktree)
        for (const wf of projectWorkflows) {
          const prev = byName.get(wf.meta.name)
          if (prev && prev.source !== 'project') overrides.set(wf.meta.name, prev.source)
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
      overrides: overrides.get(entry.meta.name) ?? null,
    }))
    return c.json({ workflows, ...(trustRequired ? { trustRequired } : {}) })
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

    // 用户刚经本入口创建的 workflow 是用户自己写的代码，先纳入信任指纹——
    // 否则「已信任项目新建工作流」会因指纹漂移（新增文件 hash）把自己重新
    // 锁出门禁（下次聊天/列出即 TRUST_REQUIRED），信任 → 创建 → 再信任的死循环。
    // 必须先于 reloadRegistry：reload 的项目级发现按 projectTrustCurrent 判定，
    // 新文件未入指纹时会误判漂移而跳过（registry 里看不到刚创建的工作流）。
    try {
      const p = await getByDirectory(ctx.db, ctx.cwd)
      if (p?.trustedAt != null) await trustProject(ctx.db, p.id)
    } catch {
      // 指纹刷新失败不阻塞创建结果（最坏回到「需重新信任」的 fail-closed 路径）
    }

    // 热重载注册表（清空 → 三级重新发现）；项目级发现按信任门禁（fail-closed），
    // 未信任 serve 目录项目时绝不 import 仓库中既有的工作流文件。
    await reloadRegistry(registry, ctx.cwd, { projectTrusted: await serveCwdTrusted(ctx) })

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

    // 项目级 fallback：仅信任项目才 dynamic import 其工作流文件。
    if (!entry) {
      const projectId = c.req.query('projectId')
      if (projectId) {
        const { project, trusted } = await projectTrustState(ctx, projectId)
        if (project && trusted) {
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
  // P1 对齐 chat 路由斜杠路径：
  //  - 信任门禁：未信任/漂移项目 409 TRUST_REQUIRED（与聊天入口同口径）；
  //  - 交互式权限：ask 工具经 SSE permission_required + 全局 store 确认（此前
  //    autoAllowChecker 无确认通道，写/执行工具静默不可用）；
  //  - 预算护栏：按项目合并配置注入 budgetPause（此前完全旁路）；
  //  - 会话绑定 projectId/worktreePath（此前丢失，继续对话会在错误目录执行）。
  app.post('/:name/run', async (c) => {
    const name = c.req.param('name')
    const registry = ctx.workflowRegistry
    if (!registry) {
      return apiError(c, 500, 'NOT_INITIALIZED', 'Workflow registry not initialized')
    }
    let entry = registry.get(name)

    // 项目级 fallback + 解析项目 worktree 作为 agent cwd
    let agentCwd = ctx.cwd
    let project: Awaited<ReturnType<typeof getProject>> = null
    const projectId = c.req.query('projectId')
    if (projectId) {
      const st = await projectTrustState(ctx, projectId)
      project = st.project
      if (project) {
        agentCwd = project.worktree
        // 信任门禁先行：未信任（或信任后漂移）项目在发现/执行前拦截——发现本身
        // 就会执行工作流模块顶层代码，必须与聊天入口同一道闸。
        const scopes = loadConfigScopes(agentCwd)
        const risks = projectTrustNeeded(
          scopes.project,
          scopes.global,
          project.trustedAt,
          project.riskFingerprint,
          project.worktree,
        )
        if (risks.length > 0) {
          const items = enrichProjectRiskWithGlobal(risks, scopes.global)
          return apiError(
            c,
            409,
            'TRUST_REQUIRED',
            `项目「${project.name ?? project.worktree}」的项目配置（.c0de/config.json 或 .c0de/workflows）包含需要你确认的风险项`,
            { projectId: project.id, projectName: project.name ?? project.worktree, items },
          )
        }
        if (st.trusted && !entry) {
          const discovered = await discoverWorkflows(project.worktree)
          entry = discovered.find((w) => w.meta.name === name)
        }
      }
    }

    if (!entry) {
      return apiError(c, 404, 'NOT_FOUND', `Workflow "${name}" not found`)
    }

    const body = await c.req.json().catch(() => ({}))
    const args = (body as { args?: string }).args ?? ''

    // 会话级配置：按 agent cwd 解析项目作用域合并（与 chat 路由同口径）；
    // 项目配置含 providers 时构建/复用项目级 LLM 注册表。
    const sessionProjectScope =
      agentCwd === ctx.cwd ? undefined : loadConfigScopes(agentCwd).project
    const sessionConfig = sessionProjectScope
      ? mergeConfig(ctx.config, sessionProjectScope)
      : ctx.config
    const sessionDefaultMode = sessionProjectScope?.permission?.defaultMode
    let sessionRegistry = ctx.llmRegistry
    if (sessionProjectScope && project) {
      const cached = ctx.projectRegistries?.get(project.id)
      if (cached) {
        sessionRegistry = cached
      } else if (sessionConfig.providers.length > 0) {
        sessionRegistry = buildRegistryFromConfig(sessionConfig)
        ctx.projectRegistries?.set(project.id, sessionRegistry)
      }
    }

    // 会话绑定 projectId + worktreePath：后续继续该会话时 agent 在正确的
    // 项目目录执行（resolveAgentCwd 不再回退 serve cwd）。
    const session = await createSession(
      ctx.db,
      `workflow:${name}`,
      project?.id ?? undefined,
      'workflow',
      undefined,
      undefined,
      project?.worktree ?? agentCwd,
    )

    const permissionTimeoutAction =
      sessionConfig.permission.timeoutAction === 'deny' ? ('deny' as const) : ('pause' as const)

    const agentConfig = {
      provider: sessionConfig.defaultProvider,
      model: sessionConfig.defaultModel,
      tools: [],
      plugins: sessionConfig.plugins.enabled,
      agentName: 'default',
    }

    // 并发占位：同步原子占位（与 chat 路由同语义），SSE 回调内 register 填充。
    if (!ctx.agentManager.tryAcquire(session.id)) {
      return apiError(c, 409, 'RUN_ACTIVE', '该会话已有进行中的工作流执行')
    }
    let handedOff = false
    try {
      const response = streamSSE(c, async (stream) => {
        const stopHeartbeat = startHeartbeat(stream)
        try {
          // 交互式权限：与 chat 路由斜杠路径一致（permission_required → 全局
          // store → /api/tools/confirm），写/执行工具不再静默不可用。
          const permissionChecker = createInteractivePermissionChecker(ctx.permissionStore, {
            getMode: () =>
              ctx.sessionPermissionModes.get(session.id) ??
              sessionDefaultMode ??
              ctx.permissionMode,
            alwaysAllow: () => ctx.sessionAlwaysAllow.get(session.id) ?? [],
            onPermissionRequired: async (req) => {
              await stream.writeSSE({
                event: 'permission_required',
                data: JSON.stringify({ _tag: 'permission_required', ...req }),
              })
            },
            onPermissionTimeout: (req) => {
              stream
                .writeSSE({
                  event: 'permission_timeout',
                  data: JSON.stringify({
                    _tag: 'permission_timeout',
                    ...req,
                    timeoutAction: permissionTimeoutAction,
                  }),
                })
                .catch(() => {})
            },
            onPermissionExpired: (req) => {
              if (permissionTimeoutAction === 'pause') {
                ctx.agentManager.pause(session.id, PERMISSION_TIMEOUT_PAUSE_REASON)
              }
              stream
                .writeSSE({
                  event: 'permission_expired',
                  data: JSON.stringify({
                    _tag: 'permission_expired',
                    ...req,
                    timeoutAction: permissionTimeoutAction,
                  }),
                })
                .catch(() => {})
            },
          })

          const deps = {
            db: ctx.db,
            llmRegistry: sessionRegistry,
            toolRegistry: ctx.toolRegistry,
            urlRegistry: ctx.urlRegistry,
            hookRunner: ctx.hookRunner,
            permission: permissionChecker,
            config: sessionConfig,
            cwd: agentCwd,
            agentRegistry: ctx.agentRegistry,
            // 预算护栏：与 chat 路由同口径（金额/token 任一轴 pause/abort 即启用）。
            ...(sessionConfig.usage?.budgetAction === 'pause' ||
            sessionConfig.usage?.budgetAction === 'abort' ||
            sessionConfig.usage?.tokenBudgetAction === 'pause' ||
            sessionConfig.usage?.tokenBudgetAction === 'abort'
              ? { budgetPause: true }
              : {}),
          }

          const parent = await createAgent(session, agentConfig, deps)
          ctx.agentManager.register({ sessionId: session.id, state: parent, deps })
          stream.onAbort(() => {
            ctx.agentManager.abort(session.id)
          })

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
          await stream
            .writeSSE({
              event: 'error',
              data: JSON.stringify({
                _tag: 'error',
                message: e instanceof Error ? e.message : String(e),
              }),
            })
            .catch(() => {})
        } finally {
          stopHeartbeat()
          ctx.agentManager.unregister(session.id)
        }
      })
      handedOff = true
      return response
    } finally {
      if (!handedOff) ctx.agentManager.unregister(session.id)
    }
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
