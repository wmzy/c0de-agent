// 插件系统初始化编排（spec §7）：创建 hookRunner + pluginRegistry，激活内置插件，
// 发现并加载外部插件（.c0de/plugins + ~/.c0de/plugins）。供 server bootstrap 与
// CLI buildAgentDeps 复用——两处启动路径此前都未接入，导致插件框架存在却永不加载。
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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
  /**
   * P0-2：项目已显式信任（projects.trustedAt 非空）时才加载项目 .c0de/plugins。
   * 缺省 false（fail-closed）：克隆仓库自带插件不会在 serve/chat 时静默执行。
   */
  projectTrusted?: boolean
}

type InitPluginsResult = {
  pluginRegistry: PluginRegistry
  hookRunner: HookRunner
  /** config:resolve hook 链之后的最终配置（无 handler 时为传入的 config 原引用）。 */
  config: Config
}

/**
 * 初始化插件系统：注册表 + hook runner + 内置插件 + 外部插件发现。
 *
 * 失败的外部插件被静默跳过（loader 已处理），单个坏插件不影响其余加载。
 * 内置插件（tool-audit-log / write-guard）始终激活。
 * P0-2：项目插件仅在项目被显式信任后加载（跳过时若目录非空则告警并给出
 * 信任途径）；全局插件是用户本机显式放置，始终加载。
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
  const projectPluginsDir = join(opts.cwd, '.c0de', 'plugins')
  if (opts.projectTrusted !== true) {
    try {
      if (existsSync(projectPluginsDir) && readdirSync(projectPluginsDir).length > 0) {
        console.warn(
          `[plugin] 项目插件目录 ${projectPluginsDir} 存在插件，但项目尚未被信任（或信任后风险配置/插件代码已变更）——已跳过加载。\n` +
            `  信任/重新确认方式：c0de trust（CLI），或在 Web 界面遇到信任确认时点击「信任项目」；信任后重启 serve 生效。`,
        )
      }
    } catch {
      // 目录读取失败不影响启动
    }
  }
  const discovered = await discoverPlugins(opts.cwd, {
    includeProject: opts.projectTrusted === true,
  })
  for (const { plugin } of discovered) {
    registerPlugin(pluginRegistry, plugin)
    await activatePlugin(pluginRegistry, plugin, services)
  }

  // config:resolve hook（HookMap 承诺的挂载点）：插件激活后对最终合并配置做链式
  // 改写（增补默认值/注入运行时密钥等）。handler 返回 false 视为「保持原配置」。
  // 结果随 InitPluginsResult.config 返回，宿主用于后续运行时消费（权限/预算/auth/
  // 调度器等）。注册表（llm/tool）在 resolve 之前构建、不重建——provider 运行时
  // 变更本就需要重启，与 Web PATCH「providers 改动提示重启」的既有语义一致。
  let resolvedConfig = opts.config
  const hookResult = await hookRunner.runHooks('config:resolve', { config: opts.config })
  if (hookResult !== false) resolvedConfig = hookResult.config

  return { pluginRegistry, hookRunner, config: resolvedConfig }
}

export type { InitPluginsOptions, InitPluginsResult }
export { initPlugins }
