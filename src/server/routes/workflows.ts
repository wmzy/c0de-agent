import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { resolveGlobalConfigDir } from '../../core/config.js'
import { discoverWorkflows, saveWorkflow } from '../../core/workflows/index.js'
import { reloadRegistry } from '../../core/workflows/registry.js'
import type { WorkflowEntry, WorkflowSource } from '../../core/workflows/types.js'
import {
  getProject,
  refreshTrustedProjectFingerprint,
  resolveCwdProjectTrusted,
} from '../../project/index.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'
import { readJsonObject } from '../util/json-body.js'
import { resolveSessionScope } from '../util/session-scope.js'
import { projectTrustState, resolveWorkflowEntry, trustGateResponse } from './trust-gate.js'
import { createRestWorkflowEmitter, runWorkflowChannel } from './workflow-run.js'

/**
 * 按名字查找运行中的工作流 run：遍历 busy 作用域占位（workflowBusyByScope 的
 * 值为工作流会话 id），从活跃 run 的会话 metadata.workflowName 匹配（斜杠与
 * REST 两条执行通道创建会话时均落盘该键）。返回工作流会话 id；无匹配返回 null。
 */
function findBusyWorkflowByName(ctx: ServerContext, name: string): string | null {
  for (const wfSessionId of ctx.workflowBusyByScope.values()) {
    if (!wfSessionId) continue // 同步占位空串（run 会话尚未创建）
    const run = ctx.agentManager.get(wfSessionId)
    if (!run) continue
    const meta = run.state.session.metadata as { workflowName?: unknown }
    if (meta?.workflowName === name) return wfSessionId
  }
  return null
}

/** 权限确认超时兜底拒绝后暂停 run 的暂停原因（与 chat 路由同口径）。 */
const PERMISSION_TIMEOUT_PAUSE_REASON =
  '权限确认超时：该工具已被自动拒绝，工作流已暂停。点击「恢复」后可直接要求 agent 重试该工具'

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

    const parsed = await readJsonObject(c)
    if (!parsed.ok) return parsed.response
    const { name, source, target, projectId, overwrite } = parsed.body as {
      name?: string
      source?: string
      target?: 'project' | 'user'
      projectId?: string
      overwrite?: boolean
    }

    if (!name || typeof name !== 'string') {
      return apiError(c, 400, 'BAD_REQUEST', 'Missing required field: name')
    }
    if (!source || typeof source !== 'string') {
      return apiError(c, 400, 'BAD_REQUEST', 'Missing required field: source')
    }
    // 目标层级必填：此前缺省 target ?? 'project' 落到 serve cwd，与 GET/run 的
    // ?projectId 口径分裂——serve cwd ≠ 目标项目时静默写错目录。
    if (target !== 'project' && target !== 'user') {
      return apiError(c, 400, 'BAD_REQUEST', 'Missing or invalid field: target (project|user)')
    }

    // 落盘目录：target=project 缺省 serve cwd；显式 projectId 时解析项目 worktree。
    // 项目级工作流是任意代码执行面，写入前必须已信任（与发现/执行同一道闸）——
    // 带 projectId 与缺省 serve cwd 两条路径同口径（P3：此前不带 projectId 时
    // 写入不查信任，未信任项目仍可被写入任意 JS 文件）。
    let saveDir = ctx.cwd
    if (target === 'project') {
      if (projectId) {
        const st = await projectTrustState(ctx, projectId)
        if (!st.project) {
          return apiError(c, 404, 'NOT_FOUND', `Project "${projectId}" not found`)
        }
        if (!st.trusted) {
          return apiError(
            c,
            409,
            'TRUST_REQUIRED',
            `项目「${st.project.name ?? st.project.worktree}」未信任（或信任后配置漂移），请先信任项目再创建工作流`,
          )
        }
        saveDir = st.project.worktree
      } else if (!(await resolveCwdProjectTrusted(ctx.db, ctx.cwd))) {
        return apiError(
          c,
          409,
          'TRUST_REQUIRED',
          'serve 启动目录的项目未信任（或信任后配置漂移）——项目级工作流是仓库自带的任意代码执行面，请先信任项目再创建工作流',
        )
      }
    }

    // 同名覆盖保护：目标层级已有同名工作流且未显式 overwrite → 409。
    // 此前 POST 无条件写文件截断——新建误输已有名称会静默替换其内容
    // （斜杠 /workflow create 有 --yes 确认，这里没有）。编辑模式由前端
    // 显式传 overwrite: true。
    const targetFilePath = join(
      target === 'project' ? join(saveDir, '.c0de') : resolveGlobalConfigDir(),
      'workflows',
      `${name}.js`,
    )
    if (existsSync(targetFilePath) && overwrite !== true) {
      return apiError(
        c,
        409,
        'ALREADY_EXISTS',
        `工作流 "${name}" 已存在（${target === 'project' ? '项目' : '用户'}级）——覆盖会替换其内容。` +
          '确认覆盖请使用「编辑」该工作流，或改用 /workflow create --yes',
      )
    }

    // 保存到磁盘 + dynamic import 验证
    const result = await saveWorkflow(name, source, target, saveDir)
    if (!result.ok) {
      return apiError(c, 400, 'SAVE_FAILED', result.error)
    }

    // 用户刚经本入口创建的 workflow 是用户自己写的代码，先纳入信任指纹——
    // 否则「已信任项目新建工作流」会因指纹漂移（新增文件 hash）把自己重新
    // 锁出门禁（下次聊天/列出即 TRUST_REQUIRED），信任 → 创建 → 再信任的死循环。
    // 必须先于 reloadRegistry：reload 的项目级发现按 projectTrustCurrent 判定，
    // 新文件未入指纹时会误判漂移而跳过（registry 里看不到刚创建的工作流）。
    try {
      await refreshTrustedProjectFingerprint(ctx.db, saveDir)
    } catch {
      // 指纹刷新失败不阻塞创建结果（最坏回到「需重新信任」的 fail-closed 路径）
    }

    // 热重载注册表（清空 → 三级重新发现）；项目级发现按信任门禁（fail-closed），
    // 未信任 serve 目录项目时绝不 import 仓库中既有的工作流文件。
    await reloadRegistry(registry, ctx.cwd, {
      projectTrusted: await resolveCwdProjectTrusted(ctx.db, ctx.cwd),
    })

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

    // 统一解析：项目级（已信任）> 用户 > 内置，与 GET / 列表口径一致。
    // 此前注册表优先——项目级同名工作流被用户级/内置遮蔽，列表显示项目版、
    // 查看/编辑打开的却是另一份。
    const { entry } = await resolveWorkflowEntry(ctx, {
      name,
      registry,
      projectId: c.req.query('projectId'),
    })

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
    // 项目级解析 + 项目 worktree 作为 agent cwd；信任门禁先行：未信任（或信任后
    // 漂移）项目在发现/执行前拦截——发现本身就会执行工作流模块顶层代码，必须与
    // 聊天入口同一道闸（门禁与条目解析均为 trust-gate.ts 单点实现）。
    let agentCwd = ctx.cwd
    const { entry, project } = await resolveWorkflowEntry(ctx, {
      name,
      registry,
      projectId: c.req.query('projectId'),
    })
    if (project) {
      agentCwd = project.worktree
      const gate = trustGateResponse(c, project, {
        riskSurfaces: '.c0de/config.json 或 .c0de/workflows',
      })
      if (gate) return gate
    }

    if (!entry) {
      return apiError(c, 404, 'NOT_FOUND', `Workflow "${name}" not found`)
    }

    const parsed = await readJsonObject(c)
    if (!parsed.ok) return parsed.response
    const args = typeof parsed.body.args === 'string' ? parsed.body.args : ''

    // 会话级配置：按 agent cwd 解析项目作用域合并（与 chat 路由同口径）；
    // 项目配置含 providers 时构建/复用项目级 LLM 注册表。
    const sessionScope = resolveSessionScope(ctx, {
      cwd: agentCwd,
      registryKey: project?.id,
    })
    const sessionConfig = sessionScope.config
    const sessionDefaultMode = sessionScope.projectScope?.permission?.defaultMode
    const sessionRegistry = sessionScope.registry

    // 执行通道与斜杠 /workflow run 共享（workflow-run.ts 单点实现）：并发守卫
    // （scope/tryAcquire）、会话生命周期、权限 checker（超时级联暂停）、deps 组装
    // （skills/debugSpawn 注入一次）、abort 级联、预算门禁；线上协议（原生
    // result/error 事件，无 done 收尾）由 REST emitter 提供。
    // cwd 口径：REST 按 ?projectId 解析项目 worktree（缺省 serve cwd）；斜杠通道用
    // 宿主会话 resolveAgentCwd——语义同为「工作流执行目录」，见 workflow-run.ts。
    return runWorkflowChannel(ctx, {
      c,
      registry,
      name,
      entry,
      args,
      cwd: agentCwd,
      projectId: project?.id ?? undefined,
      sessionConfig,
      sessionDefaultMode,
      sessionRegistry,
      tryAcquireBusyMessage: '该会话已有进行中的工作流执行',
      permissionPauseReason: PERMISSION_TIMEOUT_PAUSE_REASON,
      createEmitter: createRestWorkflowEmitter,
    })
  })

  // DELETE /:name — 删除（仅非 builtin）。可选 ?projectId=xxx&target=project|user 删除指定层级。
  // 不 dynamic import 仓库代码（删除无需信任门禁，未信任项目也可清理自己的文件），仅按路径操作。
  // target 显式指定层级：此前仅凭「项目文件是否存在」猜测——?projectId 下项目文件缺失时
  // 会静默回退删除用户级同名文件（竞态/作用域歧义），现按目标层级 404，不回退。
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
    const registryEntry = registry.get(name)
    const projectId = c.req.query('projectId')
    const target = c.req.query('target')

    // P2 运行中守卫：删除文件后运行中的 run 仍以内存模块继续执行（用户以为已停），
    // 且 lastRun 记录随注册表条目消失——崩溃后 interrupted 识别丢失。
    // 按名字匹配所有 busy 作用域（run 会话 metadata.workflowName，两通道均落盘）；
    // 同名不同层级的运行会构成假阳性阻断，但安全侧（稍后重删）。
    const busyRun = findBusyWorkflowByName(ctx, name)
    if (busyRun) {
      return apiError(
        c,
        409,
        'RUN_ACTIVE',
        `工作流 "${name}" 正在运行（会话 ${busyRun}），请先中止该运行再删除`,
      )
    }

    // 项目级删除：?projectId 指定项目 worktree；缺省 serve cwd（全局设置视图下
    // 的启动目录项目工作流）。文件缺失 → 404，绝不回退删除其他层级。
    if (target === 'project') {
      let baseDir = ctx.cwd
      if (projectId) {
        const project = await getProject(ctx.db, projectId)
        if (!project) {
          return apiError(c, 404, 'NOT_FOUND', `Project "${projectId}" not found`)
        }
        baseDir = project.worktree
      }
      const filePath = join(baseDir, '.c0de', 'workflows', `${name}.js`)
      if (!existsSync(filePath)) {
        return apiError(
          c,
          404,
          'NOT_FOUND',
          `项目级工作流 "${name}" 不存在（${join(baseDir, '.c0de', 'workflows')}）`,
        )
      }
      try {
        await unlink(filePath)
      } catch {
        return apiError(c, 500, 'DELETE_FAILED', `Failed to delete workflow file for "${name}"`)
      }
      // P1 修复：删除文件同样改变信任指纹（workflowDirHashes 随文件集变化）——
      // 不刷新会让已信任项目在下一次聊天时被误判「配置漂移」而重新门禁，
      // 与 create 路径的 trustProject 刷新对称（防「信任→删除→自锁复检」）。
      try {
        await refreshTrustedProjectFingerprint(ctx.db, baseDir)
      } catch {
        // 指纹刷新失败不阻塞删除结果（最坏回到 fail-closed 复检路径）
      }
      // 热重载：项目级条目消失后，被其遮蔽的同名 user 级条目应重新可见——
      // registry 单名单位（后注册覆盖），仅 delete 无法恢复被覆盖掉的 user 条目。
      try {
        await reloadRegistry(registry, ctx.cwd, {
          projectTrusted: await resolveCwdProjectTrusted(ctx.db, ctx.cwd),
        })
      } catch {
        // 重载失败不阻塞删除结果（其他文件损坏等）；下次启动/创建时自然恢复
      }
      return c.json({ ok: true })
    }

    // 用户级删除：仅删用户级条目（~/.c0de/workflows）。同名项目级文件存在时
    // 注册表条目是项目级——此时列表也不展示用户行，不存在此删除请求。
    if (target === 'user') {
      const userEntry = registryEntry?.source === 'user' ? registryEntry : undefined
      if (!userEntry?.filePath) {
        return apiError(c, 404, 'NOT_FOUND', `用户级工作流 "${name}" 不存在`)
      }
      try {
        await unlink(userEntry.filePath)
      } catch {
        return apiError(c, 500, 'DELETE_FAILED', `Failed to delete workflow file for "${name}"`)
      }
      // 热重载：user 级条目可能遮蔽同名 builtin，仅 delete 会让被覆盖的 builtin
      // 永久消失（registry 单名单位），重建恢复完整层级。
      try {
        await reloadRegistry(registry, ctx.cwd, {
          projectTrusted: await resolveCwdProjectTrusted(ctx.db, ctx.cwd),
        })
      } catch {
        // 重载失败不阻塞删除结果
      }
      return c.json({ ok: true })
    }

    // 兼容旧行为（无 target）：按注册表条目删除（旧客户端调用）。
    // 项目级删除目标：按 worktree 拼路径，不做 discovery（避免执行仓库代码）。
    let projectFilePath: string | null = null
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (!project) {
        return apiError(c, 404, 'NOT_FOUND', `Project "${projectId}" not found`)
      }
      const candidate = join(project.worktree, '.c0de', 'workflows', `${name}.js`)
      if (existsSync(candidate)) projectFilePath = candidate
    }

    // 无项目级文件且注册表无同名条目 → 404
    if (!projectFilePath && !registryEntry) {
      return apiError(c, 404, 'NOT_FOUND', `Workflow "${name}" not found`)
    }
    // 仅注册表条目且为内置 → 拒绝；项目级文件是用户自建代码，可删
    if (!projectFilePath && registryEntry?.source === 'builtin') {
      return apiError(c, 400, 'BAD_REQUEST', 'Cannot delete builtin workflow')
    }

    const fileToUnlink = projectFilePath ?? registryEntry?.filePath
    // 先从磁盘删除文件（若存在），失败则告知用户且不清理 registry 以保持状态一致
    if (fileToUnlink) {
      try {
        await unlink(fileToUnlink)
      } catch {
        return apiError(c, 500, 'DELETE_FAILED', `Failed to delete workflow file for "${name}"`)
      }
    }

    // P1 修复：删除项目级文件同样刷新信任指纹（与 target=project 分支同口径），
    // 防「删除→指纹漂移→自锁复检」。
    if (projectFilePath) {
      try {
        const project = await getProject(ctx.db, projectId ?? '')
        if (project) await refreshTrustedProjectFingerprint(ctx.db, project.worktree)
      } catch {
        // 指纹刷新失败不阻塞删除结果
      }
    }
    // 热重载：删除可能解除 user/builtin 同名条目的遮蔽，registry 单名单位必须重建。
    try {
      await reloadRegistry(registry, ctx.cwd, {
        projectTrusted: await resolveCwdProjectTrusted(ctx.db, ctx.cwd),
      })
    } catch {
      // 重载失败不阻塞删除结果
    }
    return c.json({ ok: true })
  })

  return app
}

export { createWorkflowsRoute }
