// Plugin lifecycle management (§7.1).
//
// Provides activate/deactivate lifecycle operations that wrap the low-level
// loader with status tracking. Each plugin goes through states:
//
//   inactive → activating → active → deactivating → inactive
//                    ↓                    ↓
//                 error                error
//
// Status is tracked in a module-level WeakMap keyed by the Plugin object
// identity, so activation state is decoupled from any registry.
//
// Conventions: data + functions, no class.

import { loadPlugin, activatePlugin as loaderActivate } from "./loader";
import type { Plugin, PluginContext } from "./types";

// ---------------------------------------------------------------------------
// PluginStatus — lifecycle state of a plugin instance.
// ---------------------------------------------------------------------------

export type PluginStatus =
  | { _tag: "inactive" }
  | { _tag: "activating" }
  | { _tag: "active"; activatedAt: number }
  | { _tag: "deactivating" }
  | { _tag: "error"; error: string; previous: PluginStatus };

// ---------------------------------------------------------------------------
// Module-level WeakMap for status tracking.
//
// Keyed by Plugin object identity so the same plugin can be activated in
// multiple registries independently. Entries are garbage-collected when
// the Plugin object is no longer reachable.
// ---------------------------------------------------------------------------

const STATUS_STORE = new WeakMap<Plugin, PluginStatus>();

// ---------------------------------------------------------------------------
// getPluginStatus — read the current lifecycle status (never throws).
// ---------------------------------------------------------------------------

export function getPluginStatus(plugin: Plugin): PluginStatus {
  return STATUS_STORE.get(plugin) ?? { _tag: "inactive" };
}

// ---------------------------------------------------------------------------
// setPluginStatus — update lifecycle status.
// ---------------------------------------------------------------------------

function setPluginStatus(plugin: Plugin, status: PluginStatus): void {
  STATUS_STORE.set(plugin, status);
}

// ---------------------------------------------------------------------------
// activatePlugin — initialise a plugin and attach it to a registry.
//
// Sets status to "activating", calls the loader's activatePlugin (which
// invokes plugin.setup()), and on success marks the plugin as "active".
// On failure, marks as "error" preserving the prior status and re-throws.
//
// Idempotent: calling activatePlugin on an already-active plugin returns
// immediately.
// ---------------------------------------------------------------------------

export async function activatePlugin(plugin: Plugin, ctx: PluginContext): Promise<void> {
  const current = getPluginStatus(plugin);

  if (current._tag === "active") {
    return; // Idempotent
  }

  setPluginStatus(plugin, { _tag: "activating" });

  try {
    await loaderActivate(plugin, ctx);
    setPluginStatus(plugin, {
      _tag: "active",
      activatedAt: Date.now(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : `activation failed: ${String(err)}`;
    setPluginStatus(plugin, {
      _tag: "error",
      error: message,
      previous: current,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// deactivatePlugin — tear down a plugin.
//
// Calls plugin.teardown() if present, then resets status to "inactive".
// Throws only if teardown itself throws (and sets status to "error").
//
// Idempotent: calling deactivatePlugin on an already-inactive plugin is a
// no-op.
// ---------------------------------------------------------------------------

export async function deactivatePlugin(plugin: Plugin): Promise<void> {
  const current = getPluginStatus(plugin);

  if (current._tag === "inactive") {
    return; // Idempotent
  }

  setPluginStatus(plugin, { _tag: "deactivating" });

  try {
    if (typeof plugin.teardown === "function") {
      await Promise.resolve(plugin.teardown());
    }
    setPluginStatus(plugin, { _tag: "inactive" });
  } catch (err) {
    const message = err instanceof Error ? err.message : `deactivation failed: ${String(err)}`;
    setPluginStatus(plugin, {
      _tag: "error",
      error: message,
      previous: current,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// loadAndActivate — convenience: load from path, then activate.
// ---------------------------------------------------------------------------

export async function loadAndActivate(path: string, ctx: PluginContext): Promise<Plugin> {
  const plugin = await loadPlugin(path);
  await activatePlugin(plugin, ctx);
  return plugin;
}

// ---------------------------------------------------------------------------
// deactivateAll — tear down every tracked plugin that is not already
// inactive. Returns a list of results, one per plugin.
// ---------------------------------------------------------------------------

export type DeactivateResult = {
  plugin: Plugin;
  success: boolean;
  error?: string;
};

export async function deactivateAll(plugins: Plugin[]): Promise<DeactivateResult[]> {
  return await Promise.all(
    plugins.map(async (plugin) => {
      try {
        await deactivatePlugin(plugin);
        return { plugin, success: true };
      } catch (err) {
        return {
          plugin,
          success: false,
          error: err instanceof Error ? err.message : `unknown error: ${String(err)}`,
        };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// isPluginActive — quick predicate check.
// ---------------------------------------------------------------------------

export function isPluginActive(plugin: Plugin): boolean {
  return getPluginStatus(plugin)._tag === "active";
}

// ---------------------------------------------------------------------------
// createLifecycleManager — bundle lifecycle helpers into a namespace.
//
// Returns a plain-object "manager" with activate/deactivate/status helpers
// pre-bound to a fixed set of plugins (useful when the caller wants a
// single handle instead of threading plugin arrays manually).
// ---------------------------------------------------------------------------

export type LifecycleManager = {
  activate: (ctx: PluginContext) => Promise<void>;
  deactivate: () => Promise<DeactivateResult[]>;
  status: () => PluginStatus[];
  isActive: (name: string) => boolean;
};

export function createLifecycleManager(plugins: Plugin[]): LifecycleManager {
  const map = new Map(plugins.map((p) => [p.name, p]));

  return {
    activate: async (ctx: PluginContext): Promise<void> => {
      for (const plugin of plugins) {
        await activatePlugin(plugin, ctx);
      }
    },
    deactivate: async (): Promise<DeactivateResult[]> => {
      return await deactivateAll(plugins);
    },
    status: (): PluginStatus[] => {
      return plugins.map((p) => getPluginStatus(p));
    },
    isActive: (name: string): boolean => {
      const plugin = map.get(name);
      return plugin ? isPluginActive(plugin) : false;
    },
  };
}
