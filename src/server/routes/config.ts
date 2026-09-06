import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import {
  applyScopedPatch,
  loadConfigScopes,
  mergeConfig,
  saveConfigScoped,
} from '../../core/config.js'
import { containsSecrets } from '../../core/redact.js'
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../../core/secret.js'
import { getProject } from '../../project/project.js'
import type { Config } from '../../shared/types/config.js'
import type { ProviderConfig } from '../../shared/types/llm.js'
import { apiError } from '../middleware/error.js'
import { syncRegistryFromConfig } from '../server.js'
import type { ServerContext } from '../types.js'

/** 检查每个 provider 的 apiKey 能否在本机解密（机器绑定密钥换机/容器重建后会失败）。 */
function providerApiKeyWarnings(providers: Config['providers']): string[] {
  const warnings: string[] = []
  for (const p of providers) {
    if (!p.apiKey || !isEncryptedSecret(p.apiKey)) continue
    try {
      decryptSecret(p.apiKey)
    } catch {
      warnings.push(
        `provider "${p.name || ''}" 的 apiKey 无法在本机解密（配置来自其他机器），请重新设置`,
      )
    }
  }
  return warnings
}

/** 项目级配置含密钥且位于 git 仓库内时提示 .gitignore（防误提交）。 */
function projectConfigGitWarning(project: Partial<Config> | undefined, cwd: string): string | null {
  if (!project || !containsSecrets(project)) return null
  let dir = cwd
  while (true) {
    if (existsSync(join(dir, '.git'))) {
      return (
        '项目级配置（.c0de/config.json）含 API Key/Token 且位于 git 仓库内，' +
        '建议将 .c0de/ 加入 .gitignore，防止密钥被误提交。'
      )
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * 解析配置读取/写入的目标目录（P1-1 多项目配置贯通）：
 * - projectId 提供且存在 → 该项目 worktree（配置读写与设置页展示都对准该项目）。
 * - 否则 → 服务启动目录（向后兼容：serve cwd 项目与全局作用域）。
 */
async function resolveConfigDir(
  ctx: ServerContext,
  projectId: string | undefined,
): Promise<{ dir: string; isProjectScoped: boolean } | null> {
  if (projectId) {
    const project = await getProject(ctx.db, projectId)
    if (!project) return null
    return { dir: project.worktree, isProjectScoped: true }
  }
  return { dir: ctx.cwd, isProjectScoped: false }
}

function createConfigRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // GET / — 合并后配置 + 作用域信息 + apiKey 解密警告 + git 误提交警告。
  // ?projectId= 时读取该项目的 global+project 作用域（默认读取服务启动目录项目，
  // 复用服务内存合并配置 ctx.config）。
  app.get('/', async (c) => {
    const projectId = c.req.query('projectId')
    const target = await resolveConfigDir(ctx, projectId)
    if (!target) return apiError(c, 404, 'PROJECT_NOT_FOUND', '项目不存在')
    const scopes = loadConfigScopes(target.dir)
    const config = projectId ? mergeConfig(scopes.global, scopes.project) : ctx.config
    return c.json({
      config,
      scopes: {
        global: scopes.global ?? null,
        project: scopes.project ?? null,
      },
      warnings: providerApiKeyWarnings(config.providers),
      gitWarning: projectConfigGitWarning(scopes.project, target.dir),
      projectDir: target.isProjectScoped ? target.dir : undefined,
    })
  })

  // PATCH / — 按作用域写入。body.scope: 'global' | 'project'（默认 project，兼容旧客户端）。
  // body.projectId：目标项目（P1-1；缺省 = 服务启动目录项目）。
  // 仅当写入目标是服务启动目录项目时同步服务级内存配置与 LLM registry——
  // 其他项目的配置不污染服务级 provider 注册表（会话级按需解析）。
  app.patch('/', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown> & {
      scope?: 'global' | 'project'
      projectId?: string
    }
    const scope = body.scope === 'global' ? 'global' : 'project'
    const { scope: _omit, projectId, ...patch } = body
    // spec §24.2：provider apiKey 落盘前加密，明文不持久化。
    // 已加密（enc: 前缀）或无 apiKey 的透传。
    if (Array.isArray(patch.providers)) {
      patch.providers = (patch.providers as ProviderConfig[]).map((p) =>
        p.apiKey && !isEncryptedSecret(p.apiKey) ? { ...p, apiKey: encryptSecret(p.apiKey) } : p,
      )
    }
    // 按作用域最小落盘：patch 只合并进指定作用域原始文件，
    // 不把合并结果（含默认值/另一作用域配置）整体序列化进文件。
    // null 值 = 删除该作用域中的键（回落到另一作用域/默认值）。
    const target = await resolveConfigDir(ctx, projectId)
    if (!target) return apiError(c, 404, 'PROJECT_NOT_FOUND', '项目不存在')
    const scopes = loadConfigScopes(target.dir)
    const nextScoped =
      scope === 'global'
        ? applyScopedPatch(scopes.global ?? {}, patch)
        : applyScopedPatch(scopes.project ?? {}, patch)

    // P2-3：落盘失败必须反馈给前端（此前静默吞掉，UI 显示已保存但重启后丢失）。
    // 先落盘、成功后才更新内存配置与 registry，保证「已保存」反馈与磁盘状态一致。
    try {
      await saveConfigScoped(scope, target.dir, nextScoped)
    } catch (err) {
      return apiError(
        c,
        500,
        'CONFIG_SAVE_FAILED',
        `配置保存失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const isServerCwdProject = target.dir === ctx.cwd
    if (isServerCwdProject || scope === 'global') {
      // global 作用域写入影响所有项目（含服务级 provider 注册表），
      // 按服务启动目录作用域重建 ctx.config 并同步 registry。
      const serverScopes = loadConfigScopes(ctx.cwd)
      ctx.config = mergeConfig(serverScopes.global, serverScopes.project)
      syncRegistryFromConfig(ctx.llmRegistry, ctx.config)
      // 项目级注册表基于全局作用域构建，global 变更后全部失效。
      ctx.projectRegistries?.clear()
    } else if (projectId) {
      // 项目作用域写入：该项目的会话级注册表缓存失效。
      ctx.projectRegistries?.delete(projectId)
    }

    const freshScopes = loadConfigScopes(target.dir)
    const merged = mergeConfig(freshScopes.global, freshScopes.project)
    // 启动时一次性读取的配置：运行时修改不生效——告知前端提示重启。
    //  - security：authManager/CORS 在启动时构建
    //  - update：调度器 interval 与 handoff server 在启动时构建
    //  - plugins：hookRunner/插件生命周期在启动时初始化
    // 仅当写入影响运行中的服务级配置（服务启动目录项目或 global 作用域）时提示。
    const needsRestart =
      (isServerCwdProject || scope === 'global') &&
      (patch.security !== undefined || patch.update !== undefined || patch.plugins !== undefined)
    return c.json({
      config: merged,
      scopes: {
        global: freshScopes.global ?? null,
        project: freshScopes.project ?? null,
      },
      warnings: providerApiKeyWarnings(merged.providers),
      needsRestart,
      projectDir: target.isProjectScoped ? target.dir : undefined,
    })
  })

  return app
}

export { createConfigRoute }
