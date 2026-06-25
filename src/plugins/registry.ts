// Plugin registry (§7.2).
//
// Implements registry operations as plain functions operating on the opaque
// PluginRegistry nominal type from ./types. The actual Map<name, Plugin> is
// held in a module-level WeakMap keyed by the registry object itself, which
// gives automatic cleanup when the registry is garbage-collected and zero
// exported surface for the storage internals.
//
// Public functions:
//   - createPluginRegistry(): PluginRegistry
//   - registerPlugin(registry, plugin): void
//   - getPlugin(registry, name): Plugin | undefined
//   - listPlugins(registry): Plugin[]
//
// Conventions: data + functions, no class.

import type { Plugin, PluginRegistry } from "./types";

// ---------------------------------------------------------------------------
// Module-private WeakMap storage
// ---------------------------------------------------------------------------

const PLUGIN_STORE = new WeakMap<PluginRegistry, Map<string, Plugin>>();

// ---------------------------------------------------------------------------
// createPluginRegistry — public constructor.
//
// Allocates an empty object and seeds the WeakMap with a fresh plugin map.
// The returned value is opaque: its brand field exists at runtime but is
// only inspectable by code that holds a reference to this module.
// ---------------------------------------------------------------------------

export function createPluginRegistry(): PluginRegistry {
  const registry = {} as PluginRegistry;
  PLUGIN_STORE.set(registry, new Map());
  return registry;
}

// ---------------------------------------------------------------------------
// registerPlugin — add or replace a plugin by name
// ---------------------------------------------------------------------------

export function registerPlugin(registry: PluginRegistry, plugin: Plugin): void {
  const store = PLUGIN_STORE.get(registry);
  if (!store) {
    throw new Error(
      "registerPlugin: invalid PluginRegistry (was not created via createPluginRegistry)",
    );
  }
  store.set(plugin.name, plugin);
}

// ---------------------------------------------------------------------------
// getPlugin — lookup by name
// ---------------------------------------------------------------------------

export function getPlugin(registry: PluginRegistry, name: string): Plugin | undefined {
  return PLUGIN_STORE.get(registry)?.get(name);
}

// ---------------------------------------------------------------------------
// listPlugins — snapshot of all registered plugins
// ---------------------------------------------------------------------------

export function listPlugins(registry: PluginRegistry): Plugin[] {
  const store = PLUGIN_STORE.get(registry);
  if (!store) return [];
  return Array.from(store.values());
}
