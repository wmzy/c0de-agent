// 插件系统初始化编排（spec §7）：创建 hookRunner + pluginRegistry，激活内置插件，
// 发现并加载外部插件（.c0de/plugins + ~/.c0de/plugins）。供 server bootstrap 与
// CLI buildAgentDeps 复用——两处启动路径此前都未接入，导致插件框架存在却永不加载。
import type { Config } from '../shared/types/config.js'
import { registerBuiltinHooks } from './builtin.js'
import { createHookRunner } from './hooks.js'
import { activatePlugin } from './lifecycle.js'
import { discoverPlugins } from './loader.js'
import { createPluginRegistry, registerPlugin } from './registry.js'
import type { HookRunner, PluginRegistry, PluginServices } from './types.js'

type InitPluginsOptions = {
  cwd: string
  config: Config
  /** 工具注册表；插件通过 registerTool 往这里注入（spec §7.2 PluginContext）。 */
  toolRegistry: unknown
  /** LLM 注册表；插件通过 registerProvider 往这里注入。 */
  llmRegistry: unknown
}

type InitPluginsResult = {
  pluginRegistry: PluginRegistry
  hookRunner: HookRunner
}

/**
 * 初始化插件系统：注册表 + hook runner + 内置插件 + 外部插件发现。
 *
 * 失败的外部插件被静默跳过（loader 已处理），单个坏插件不影响其余加载。
 * 内置插件（tool-audit-log / write-guard）始终激活。
 */
async function initPlugins(opts: InitPluginsOptions): Promise<InitPluginsResult> {
  const hookRunner = createHookRunner()
  const pluginRegistry = createPluginRegistry(hookRunner)
  const services: PluginServices = {
    config: opts.config,
    toolRegistry: opts.toolRegistry,
    llmRegistry: opts.llmRegistry,
  }

  // 内置插件先激活：它们注册 tool:before/after hook，对后续外部插件同样生效。
  await registerBuiltinHooks(pluginRegistry, services)

  // 发现并加载外部插件（项目 .c0de/plugins 与全局 ~/.c0de/plugins）。
  const discovered = await discoverPlugins(opts.cwd)
  for (const { plugin } of discovered) {
    registerPlugin(pluginRegistry, plugin)
    await activatePlugin(pluginRegistry, plugin, services)
  }

  return { pluginRegistry, hookRunner }
}

export type { InitPluginsOptions, InitPluginsResult }
export { initPlugins }
