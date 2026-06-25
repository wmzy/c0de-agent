// Hook system (§7.3).
//
// Provides the hook registration and execution framework for the plugin
// system. Hooks allow plugins to intercept and modify behaviour at key
// points in the agent lifecycle.
//
// Public functions:
//   - registerHook<K>(registry, hook, handler) — attach a handler
//   - runHooks<K>(registry, hook, data)        — execute all handlers chainwise
//
// Internals:
//   - Hook storage is a WeakMap keyed by PluginRegistry.
//   - Each hook point holds an array of { handler, timeout } entries.
//   - Execution chains: each handler's return value becomes the input to the
//     next handler. A handler that times out (>5 s) is silently skipped.
//   - Per-spec: before_* hooks can modify input or short-circuit via a return
//     value; after_* hooks can modify output. The chain always passes the
//     transformed value forward.
//
// Conventions: data + functions, no class.

import type { HookHandler, HookMap, PluginRegistry } from "./types";

// ---------------------------------------------------------------------------
// Internal: erased handler — we erase the generic type at storage and
// re-cast at retrieval, since the hook name string acts as the type witness.
// ---------------------------------------------------------------------------

type InternalHookEntry = {
  // biome-ignore lint/suspicious/noExplicitAny: erased generic for uniform storage
  handler: HookHandler<any>;
  timeout: number;
};

const HOOK_STORE = new WeakMap<PluginRegistry, Map<string, InternalHookEntry[]>>();

function ensureStore(registry: PluginRegistry): Map<string, InternalHookEntry[]> {
  let store = HOOK_STORE.get(registry);
  if (!store) {
    store = new Map();
    HOOK_STORE.set(registry, store);
  }
  return store;
}

// ---------------------------------------------------------------------------
// registerHook — attach a handler to a named hook point.
//
// Multiple handlers may be registered for the same hook; they are executed
// in registration order when runHooks is called.
// Override timeout (ms) is optional; defaults to 5000.
// ---------------------------------------------------------------------------

export function registerHook<K extends keyof HookMap>(
  registry: PluginRegistry,
  hook: K,
  handler: HookHandler<HookMap[K]>,
  timeout?: number,
): void {
  const store = ensureStore(registry);
  const entries = store.get(hook as string) ?? [];
  // Per-spec §7.3: default hook timeout is 5 s
  const ms = timeout ?? 5000;
  entries.push({ handler: handler as InternalHookEntry["handler"], timeout: ms });
  store.set(hook as string, entries);
}

// ---------------------------------------------------------------------------
// runHooks — execute all handlers for a given hook in registration order.
//
// Each handler receives the return value of the previous handler (chain
// pattern). If a handler throws or times out (default 5 s) it is silently
// skipped and the chain continues with the previous return value.
//
// Never rejects: errors inside handlers are caught and the original or
// last-good data is returned.
// ---------------------------------------------------------------------------

export async function runHooks<K extends keyof HookMap>(
  registry: PluginRegistry,
  hook: K,
  data: HookMap[K],
): Promise<HookMap[K]> {
  const entries = HOOK_STORE.get(registry)?.get(hook as string);
  if (!entries || entries.length === 0) {
    return data;
  }

  let current: HookMap[K] = data;

  for (const entry of entries) {
    try {
      current = await withTimeout(
        // Safe: hook name is the type witness — registerHook only accepts
        // handlers matching HookMap[K] for this hook name.
        // Promise.resolve handles both sync and async returns uniformly.
        Promise.resolve((entry.handler as HookHandler<HookMap[K]>)(current)),
        entry.timeout,
        current,
      );
    } catch {
      // Handler threw synchronously — continue with previous value
    }
  }

  return current;
}

// ---------------------------------------------------------------------------
// withTimeout — race a promise against a timeout.
//
// If the promise wins it is returned. If the timeout fires the `fallback`
// value is returned (no rejection).
// ---------------------------------------------------------------------------

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const result = await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`hook timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });

  return result;
}
