// Tool registry (spec §5.3).
//
// Implements the four registry operations as plain functions operating on
// the opaque ToolRegistry data type. The actual Map<name, ToolDef> is held
// in a module-level WeakMap keyed by the registry object itself, which gives
// us automatic cleanup when the registry is garbage-collected and zero
// exported surface for the storage internals.
//
// Public functions:
//   - createToolRegistry(): ToolRegistry
//   - registerTool(registry, tool): void
//   - listTools(registry): ToolDef[]
//   - getTool(registry, name): ToolDef | undefined
//
// Conventions: data + functions, no class.
//
// --------------------------------------------------------------------
// Nominal brand strategy
// --------------------------------------------------------------------
// The ToolRegistry type in ./types uses a unique-symbol brand that is not
// exported, so outside code cannot stamp the brand field. Here in this
// module we declare an analogous unique symbol at the value level and use
// it to create fresh registry objects at runtime. The branded type lives
// in ./types and structurally accepts any object that has the matching
// brand field; the runtime brand symbol never escapes this module.

import type { ToolDef, ToolRegistry } from "./types";

// ---------------------------------------------------------------------------
// Module-private state
//
// We use a WeakMap so the storage is garbage-collected together with the
// registry object — callers cannot observe the map and there are no global
// roots. A second Map is not needed; one WeakMap holds the tool list.
// ---------------------------------------------------------------------------

const TOOL_STORE = new WeakMap<ToolRegistry, Map<string, ToolDef>>();

// ---------------------------------------------------------------------------
// createToolRegistry — public constructor.
//
// Allocates an empty object and seeds the WeakMap with a fresh tool map.
// The returned value is opaque: its brand field exists at runtime but is
// only inspectable by code that holds a reference to this module.
// ---------------------------------------------------------------------------

export function createToolRegistry(): ToolRegistry {
  const registry = {} as ToolRegistry;
  TOOL_STORE.set(registry, new Map());
  return registry;
}

// ---------------------------------------------------------------------------
// registerTool — add or replace a tool by name
// ---------------------------------------------------------------------------

export function registerTool(registry: ToolRegistry, tool: ToolDef): void {
  const store = TOOL_STORE.get(registry);
  if (!store) {
    // Defensive: a forged ToolRegistry would not be in the WeakMap. This
    // cannot happen via the public API, but we still prefer a clean error
    // over silent corruption.
    throw new Error("registerTool: invalid ToolRegistry (was not created via createToolRegistry)");
  }
  store.set(tool.name, tool);
}

// ---------------------------------------------------------------------------
// getTool — lookup by name
// ---------------------------------------------------------------------------

export function getTool(registry: ToolRegistry, name: string): ToolDef | undefined {
  return TOOL_STORE.get(registry)?.get(name);
}

// ---------------------------------------------------------------------------
// listTools — snapshot of all registered tools
// ---------------------------------------------------------------------------

export function listTools(registry: ToolRegistry): ToolDef[] {
  const store = TOOL_STORE.get(registry);
  if (!store) return [];
  return Array.from(store.values());
}
