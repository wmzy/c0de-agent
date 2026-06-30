// src/plugins/index.ts

export {
  BUILTIN_PLUGINS,
  createToolAuditLogger,
  createWriteGuard,
  registerBuiltinHooks,
} from './builtin.js'
export { createHookRunner } from './hooks.js'
export type { InitPluginsOptions, InitPluginsResult } from './init.js'
export { initPlugins } from './init.js'
export {
  activatePlugin,
  createPluginContext,
  deactivateAll,
  deactivatePlugin,
} from './lifecycle.js'
export { discoverPlugins, loadPlugin, validatePluginModule } from './loader.js'
export { createLogger } from './logger.js'
export {
  createPluginRegistry,
  getPlugin,
  listPlugins,
  registerPlugin,
  unregisterPlugin,
} from './registry.js'
export type {
  HookHandler,
  HookMap,
  HookRunner,
  HookRunnerOptions,
  Logger,
  LogLevel,
  Plugin,
  PluginContext,
  PluginRecord,
  PluginRegistry,
  PluginServices,
  PluginStatus,
} from './types.js'
