// Plugin system types (§7 of the design spec).
//
// Defines the core plugin abstractions:
//   - Plugin, PluginContext  — what a plugin is and what it gets at setup
//   - HookHandler<T>         — shape of a hook callback
//   - HookMap                — known hook points keyed by name
//   - PluginRegistry         — opaque nominal type backed by WeakMap in registry.ts
//   - PluginLogger           — scoped logger handed to each plugin
//
// Conventions: data + functions, no class, no enum.

import type { Config } from "../core/types";
import type { ProviderConfig } from "../llm";
import type { Session } from "../session";
import type { ToolDef } from "../tools/types";

// ---------------------------------------------------------------------------
// HookHandler
// ---------------------------------------------------------------------------

export type HookHandler<T> = (data: T) => T | Promise<T>;

// ---------------------------------------------------------------------------
// HookMap — the built-in hook points (§7.3)
//
// These match the AgentHookMap in core/types but are owned here so the
// plugin system can define them without a core dependency on plugins.
// ---------------------------------------------------------------------------

export type HookMap = {
  "tool:before": { tool: string; input: unknown; ctx: unknown };
  "tool:after": { tool: string; input: unknown; result: unknown; ctx: unknown };
  "provider:before_request": { request: unknown };
  "provider:after_response": { chunks: unknown[] };
  "session:create": { session: Session };
  "session:fork": { source: Session; fork: Session };
  "message:before": { messages: unknown[] };
  "message:after": { message: unknown };
  "config:resolve": { config: Config };
};

// ---------------------------------------------------------------------------
// PluginLogger — minimal structured logger for plugin use
// ---------------------------------------------------------------------------

export type PluginLogger = {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
  debug: (msg: string, ...args: unknown[]) => void;
};

// ---------------------------------------------------------------------------
// PluginContext — handed to every plugin's setup() call
// ---------------------------------------------------------------------------

export type PluginContext = {
  registerTool: (tool: ToolDef) => void;
  registerProvider: (provider: ProviderConfig) => void;
  registerHook: <K extends keyof HookMap>(hook: K, handler: HookHandler<HookMap[K]>) => void;
  getConfig: () => Config;
  getLogger: (name: string) => PluginLogger;
};

// ---------------------------------------------------------------------------
// Plugin — a single plugin descriptor
// ---------------------------------------------------------------------------

export type Plugin = {
  name: string;
  version: string;
  setup: (ctx: PluginContext) => void | Promise<void>;
  /**
   * Optional teardown called by deactivatePlugin() to allow the plugin
   * to clean up resources (timers, connections, event listeners).
   */
  teardown?: () => void | Promise<void>;
};

// ---------------------------------------------------------------------------
// PluginRegistry — opaque nominal type.
//
// The brand is a module-private unique symbol stamped at construction time
// inside registry.ts. External code can only create PluginRegistry instances
// via createPluginRegistry(), ensuring the backing WeakMap is always
// populated.
// ---------------------------------------------------------------------------

declare const PluginRegistryBrand: unique symbol;

export type PluginRegistry = {
  readonly [PluginRegistryBrand]: true;
};
