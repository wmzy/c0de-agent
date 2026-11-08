// 宿主启动序列的单一实现：CLI buildAgentDeps 与 server buildServerContext 共用。
// 此前两份逐行同构的实现（连信任门禁注释都互为副本），读取侧必然漂移——收敛于此，
// 两端只保留各自生命周期差异的注释。

import type { DB } from '../db/client.js'
import type { Registry } from '../llm/registry.js'
import { collectScopedMCPServers, registerMCPServers } from '../mcp/index.js'
import type { MCPSession } from '../mcp/types.js'
import type { HookRunner, PluginRegistry } from '../plugins/index.js'
import { initPlugins } from '../plugins/index.js'
import { resolveCwdProjectTrusted } from '../project/index.js'
import type { Config } from '../shared/types/config.js'
import { createDefaultRegistry, type ToolRegistry } from '../tools/index.js'
import { loadConfig, loadConfigScopes } from './config.js'
import { buildRegistryFromConfig } from './provider-registry.js'

type BootstrapOptions = {
  /** 宿主已加载的 config（CLI 入口加载后还用于预算预检/入口横幅等，且测试注入
   *  合成 config）。省略时在此加载（server 路径）。 */
  config?: Config
}

type BootstrapResult = {
  config: Config
  toolRegistry: ToolRegistry
  llmRegistry: Registry
  pluginRegistry: PluginRegistry
  hookRunner: HookRunner
  /** config:resolve hook 链之后的最终配置（无 handler 时为 config 原引用）。 */
  resolvedConfig: Config
  /** 已连接 MCP 会话：宿主持有用于关闭清理（CLI 进程级生命周期，无需断开）。 */
  mcpSessions: MCPSession[]
  projectTrusted: boolean
}

/**
 * 组装宿主运行时公共底座：config → 工具/LLM 注册表 → 项目信任解析 → 插件初始化
 * → MCP 服务器注册。CLI 与 server 两条启动路径的单一正本。
 *
 * 信任门禁（fail-closed，单一正本）：
 * - P0-2：项目插件与项目作用域 MCP 只在项目被显式信任后加载——克隆仓库自带的
 *   .c0de/plugins / mcpServers 不会在首次启动时静默执行；c0de trust / Web 信任后
 *   重启生效。未注册项目（首次启动尚无项目记录，或 CLI 内存库 --temp/锁冲突降级）
 *   视为未信任。
 * - P0（代码面）：已信任但指纹漂移（git pull 改了插件代码/MCP 参数/风险键）→
 *   同样不加载——与聊天门禁同口径，杜绝「先重启、后门禁」窗口里执行漂移代码。
 *
 * MCP（spec §6）：把配置中的 MCP 服务器工具适配进 toolRegistry，对 agent 透明。
 * 全局作用域（用户本机显式配置）始终连接；项目作用域（随 git clone 传播的任意
 * 命令执行面）仅在项目已信任时连接——与插件加载同口径。逐台隔离：单台失败告警
 * 跳过，不拖垮启动。
 */
async function bootstrapRuntime(
  cwd: string,
  db: DB,
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const config = opts.config ?? (await loadConfig(cwd))
  const toolRegistry = createDefaultRegistry(config)
  const llmRegistry = buildRegistryFromConfig(config)
  const projectTrusted = await resolveCwdProjectTrusted(db, cwd)
  const {
    pluginRegistry,
    hookRunner,
    config: resolvedConfig,
  } = await initPlugins({
    cwd,
    config,
    toolRegistry,
    llmRegistry,
    projectTrusted,
  })
  const { sessions: mcpSessions } = await registerMCPServers(
    toolRegistry,
    collectScopedMCPServers(loadConfigScopes(cwd), projectTrusted),
  )
  return {
    config,
    toolRegistry,
    llmRegistry,
    pluginRegistry,
    hookRunner,
    resolvedConfig,
    mcpSessions,
    projectTrusted,
  }
}

export type { BootstrapOptions, BootstrapResult }
export { bootstrapRuntime }
