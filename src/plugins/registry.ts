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

function getPlugin(registry: PluginRegistry, name: string): PluginRecord | undefined {
  return registry.plugins.get(name)
}

function listPlugins(registry: PluginRegistry): PluginRecord[] {
  return Array.from(registry.plugins.values())
}

function unregisterPlugin(registry: PluginRegistry, name: string): boolean {
  return registry.plugins.delete(name)
}

export { createPluginRegistry, getPlugin, listPlugins, registerPlugin, unregisterPlugin }
