// src/plugins/registry.ts
import type { HookRunner, Plugin, PluginRecord, PluginRegistry } from './types.js'

function createPluginRegistry(hookRunner: HookRunner): PluginRegistry {
  return {
    plugins: new Map(),
    hookRunner,
  }
}

function registerPlugin(registry: PluginRegistry, plugin: Plugin): void {
  const record: PluginRecord = {
    plugin,
    status: 'loaded',
    disposeHandlers: [],
  }
  registry.plugins.set(plugin.name, record)
}

export { createPluginRegistry, registerPlugin }
