// src/server/util/session-scope.ts
import { type Config, loadConfigScopes, mergeConfig } from '../../core/config.js'
import { buildRegistryFromConfig } from '../../core/provider-registry.js'
import type { Registry } from '../../llm/registry.js'
import type { ServerContext } from '../types.js'

/** provider 路由的注册表缓存键前缀。其配置基线（实时读盘 mergeConfig(global,
 *  project)，不含 serve 目录项目作用域与插件 config:resolve 产物）与会话路径
 *  （ctx.config + 项目作用域）不同——同 projectId 直接共用缓存会让两种口径的
 *  注册表互相污染（会话丢 serve 项目 provider / 设置页多出会话口径条目），
 *  故加前缀隔离。 */
const PROVIDER_REGISTRY_KEY_PREFIX = 'provider-config:'

/** 会话级作用域解析结果。 */
export type SessionScope = {
  /** 合并后的会话级配置（无项目作用域时即基线配置，不克隆）。 */
  config: Config
  /** 项目作用域原始配置（cwd === ctx.cwd 或项目无 .c0de/config.json 时 undefined）。
   *  调用方用于提取「仅项目文件显式设置才生效」的键（如 permission.defaultMode）。 */
  projectScope: Partial<Config> | undefined
  /** 会话级 LLM 注册表（项目 providers 非空时构建，按 registryKey 缓存复用）。 */
  registry: Registry
}

export type SessionScopeOptions = {
  /** 会话/项目执行目录。cwd === ctx.cwd 时不读项目作用域（配置即基线）。 */
  cwd: string
  /** 注册表缓存键（会话绑定项目的 projectId）：提供且项目作用域存在时经
   *  ctx.projectRegistries 缓存复用（config PATCH 时失效，见 config 路由）。 */
  registryKey?: string
  /** 无缓存键（孤儿会话/未绑定项目的目录）时是否仍按合并配置现建项目注册表：
   *  compact/files 的历史口径（providers 非空即建）；chat/workflows 的孤儿会话
   *  不建（沿用服务级注册表）。 */
  buildWithoutKey?: boolean
  /** 配置基线：
   *  - 'service'（默认，会话路径）= mergeConfig(ctx.config, 项目作用域)。
   *    ctx.config = loadConfig(serve cwd) + 插件 config:resolve 产物，含 serve
   *    目录自身的项目作用域。
   *  - 'disk'（provider 路由）= mergeConfig(scopes.global, scopes.project)，实时
   *    读盘、不与 ctx.cwd 比较（设置页要展示落盘现状而非启动快照）。与 ctx.config
   *    不等价，注册表缓存键加前缀隔离。
   *    该口径下注册表只看合并结果 providers 是否非空（无项目文件时全局 providers
   *    同样触发构建），与旧实现一致。 */
  baseline?: 'service' | 'disk'
}

/**
 * 会话级配置/注册表解析的单点实现：cwd ≠ serve cwd 时读该项目 .c0de/config.json
 * 作用域合并到基线配置；项目配置含 providers 时构建/复用项目级 LLM 注册表。
 * 此前 5 处（chat/workflows/session/provider/files）各自内联，缓存与孤儿会话
 * 口径已开始漂移。
 */
export function resolveSessionScope(ctx: ServerContext, opts: SessionScopeOptions): SessionScope {
  // disk 基线（provider 路由）：见 SessionScopeOptions.baseline 注释。
  if (opts.baseline === 'disk') {
    const scopes = loadConfigScopes(opts.cwd)
    const config = mergeConfig(scopes.global, scopes.project)
    let registry = ctx.llmRegistry
    if (config.providers.length > 0) {
      const key = opts.registryKey ? PROVIDER_REGISTRY_KEY_PREFIX + opts.registryKey : undefined
      const cached = key ? ctx.projectRegistries?.get(key) : undefined
      registry = cached ?? buildRegistryFromConfig(config)
      if (key && !cached) ctx.projectRegistries?.set(key, registry)
    }
    return { config, projectScope: scopes.project, registry }
  }

  // service 基线（会话路径）。
  const projectScope = opts.cwd === ctx.cwd ? undefined : loadConfigScopes(opts.cwd).project
  const config = projectScope ? mergeConfig(ctx.config, projectScope) : ctx.config
  let registry = ctx.llmRegistry
  if (projectScope) {
    const cached = opts.registryKey ? ctx.projectRegistries?.get(opts.registryKey) : undefined
    if (cached) {
      registry = cached
    } else if (config.providers.length > 0 && (opts.registryKey || opts.buildWithoutKey)) {
      registry = buildRegistryFromConfig(config)
      if (opts.registryKey) ctx.projectRegistries?.set(opts.registryKey, registry)
    }
  }
  return { config, projectScope, registry }
}

/** 使某项目的全部注册表缓存失效（会话口径 + provider 口径）。config PATCH 的
 *  项目作用域写入分支调用。 */
export function invalidateProjectRegistries(ctx: ServerContext, projectId: string): void {
  ctx.projectRegistries?.delete(projectId)
  ctx.projectRegistries?.delete(PROVIDER_REGISTRY_KEY_PREFIX + projectId)
}
