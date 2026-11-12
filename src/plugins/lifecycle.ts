// src/plugins/lifecycle.ts

import type { Registry as LLMRegistry } from '../llm/registry.js'
import { registerProvider as registerLLMProvider } from '../llm/registry.js'
import type { ProviderConfig } from '../shared/types/llm.js'
import { registerTool } from '../tools/registry.js'
import type { ToolRegistry } from '../tools/types.js'
import { createLogger } from './logger.js'
import type {
  HookRunner,
  Logger,
  Plugin,
  PluginContext,
  PluginRegistry,
  PluginServices,
  ToolDef,
} from './types.js'

function createPluginContext(
  services: PluginServices,
  hookRunner: HookRunner,
  disposeHandlers: (() => void | Promise<void>)[],
): PluginContext {
  const toolRegistry = services.toolRegistry as ToolRegistry
  const llmRegistry = services.llmRegistry as LLMRegistry

  return {
    registerTool: (tool: ToolDef) => {
      registerTool(toolRegistry, tool)
    },
    registerProvider: (provider: ProviderConfig) => {
      if (provider.baseURL) {
        registerLLMProvider(llmRegistry, {
          name: provider.name,
          baseURL: provider.baseURL,
          apiKey: provider.apiKey,
        })
      } else {
        // 静默丢弃会让插件作者拼错字段名时 provider 无声消失（与 loader 的
        // 「坏插件告警并跳过」口径一致）。
        console.warn(`[plugin] registerProvider 跳过无 baseURL 的 provider "${provider.name}"`)
      }
    },
    on: hookRunner.on,
    off: hookRunner.off,
    getConfig: () => services.config,
    getLogger: (name: string): Logger => createLogger(name),
    onDispose: (handler: () => void | Promise<void>) => {
      disposeHandlers.push(handler)
    },
  }
}

async function activatePlugin(
  registry: PluginRegistry,
  plugin: Plugin,
  services: PluginServices,
): Promise<void> {
  const record = registry.plugins.get(plugin.name)
  if (!record) return
  if (record.status === 'active') return

  const ctx = createPluginContext(services, registry.hookRunner, record.disposeHandlers)
  try {
    await plugin.setup(ctx)
    record.status = 'active'
    record.error = undefined
  } catch (err) {
    record.status = 'error'
    record.error = err instanceof Error ? err.message : String(err)
    // 模块加载成功但 setup() 抛错时若不告警，插件静默失效且无任何提示——
    // 与 loader 的 import 失败告警同前缀口径（initPlugins 不检查 status）。
    console.warn(`[plugin] "${plugin.name}" setup() 失败：`, record.error)
  }
}

async function deactivatePlugin(registry: PluginRegistry, name: string): Promise<void> {
  const record = registry.plugins.get(name)
  if (!record) return

  for (const handler of record.disposeHandlers) {
    try {
      await handler()
    } catch {
      // Dispose errors are non-fatal
    }
  }
  record.disposeHandlers = []

  if (record.plugin.dispose) {
    try {
      await record.plugin.dispose()
    } catch {
      // Non-fatal
    }
  }

  record.status = 'inactive'
}

async function deactivateAll(registry: PluginRegistry): Promise<void> {
  const names = Array.from(registry.plugins.keys())
  await Promise.all(names.map((name) => deactivatePlugin(registry, name)))
}

export { activatePlugin, createPluginContext, deactivateAll, deactivatePlugin }
