# Plugins & Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `src/plugins/` package — a process-level plugin system with a priority-ordered hook/event registry, plugin discovery/loading, lifecycle management (activate/deactivate), and built-in hooks — plus integrate hooks into the core agent loop at the tool-execution, provider-request, and message boundaries.

**Architecture:** Data+functions paradigm. The `HookRunner` is a mutable event registry: plugins register typed handlers via `runner.on(event, handler, priority)`. Before-events (`tool:before`, `provider:before`, `message:before`) execute as a chain — each handler receives the output of the previous and can modify data or return `false` to abort. After-events (`tool:after`, `provider:after`, `message:after`) are fire-and-forget with error isolation. The runner is injected into `AgentDependencies` as an optional `hookRunner`, making the integration zero-cost when no plugins are loaded. The `PluginRegistry` stores loaded plugins and their dispose handlers; `lifecycle.ts` wires `PluginContext` to the real `ToolRegistry`/`Registry`/`HookRunner`.

**Tech Stack:** TypeScript (ESM/NodeNext, strict), Vitest, Node `fs` (plugin discovery), dynamic `import()` (plugin loading).

---

## Design Decisions

1. **HookMap is a single unified map** reconciling spec §3.7 (`AgentHookMap`), §7.3 (`HookMap`), and module spec §2.3 (`EventMap`). Uses `domain:before` / `domain:after` colon-separated naming. Covers agent, tool, provider, message, session, and config lifecycle points.

2. **Two execution modes.** `runHooks` (chain, for `before` events): handlers sorted by priority, each receives the previous handler's output, returns modified data or `false` (abort). `fireHooks` (broadcast, for `after` events): all handlers run in parallel via `Promise.allSettled`, return values ignored, errors swallowed.

3. **Timeout protection.** Each handler is wrapped in a `withTimeout` race (default 5s). A timed-out handler is skipped (treated as no-op in chain, or error-swallowed in broadcast) and a warning is logged. This prevents a misbehaving plugin from hanging the agent.

4. **Error isolation.** A handler that throws does not crash the loop — the error is logged and the chain continues with the last good data. In broadcast mode, `Promise.allSettled` ensures one handler's rejection doesn't affect others.

5. **`hookRunner` is optional in `AgentDependencies`.** When `undefined`, the loop skips all hook calls with zero overhead. Existing tests (which don't use hooks) continue to pass unchanged.

6. **Plugin registration flow.** Plugin-registered tools go directly into the shared `ToolRegistry` (via `registerTool(toolRegistry, tool)`), so the agent loop picks them up automatically. Plugin-registered providers go into the LLM `Registry` (via `registerProvider(llmRegistry, input)`). Plugin-registered hooks go into the `HookRunner`.

7. **Plugin discovery is directory-based.** Scans `projectDir/.c0de/plugins/` and `~/.c0de/plugins/` for subdirectories containing an `index.js` (or `index.ts` in dev). Each subdirectory is a plugin. npm-package discovery (`c0de-plugin-*`) is deferred to a future plan.

8. **`PluginContext.on` delegates to `HookRunner.on`.** Plugins receive the type-safe `on<K extends keyof HookMap>(event, handler, priority?)` method — they can't register handlers for unknown events.

9. **Built-in hooks are plain `Plugin` objects.** Two built-ins: `tool-audit-log` (logs all tool activity) and `write-guard` (warns before overwriting existing files via `tool:before`). They are opt-in via `registerBuiltinHooks(runner, names?)`.

10. **`return false` = abort; `return undefined` = passthrough.** In chain mode, a handler that returns `void`/`undefined` is treated as "no modification" — the original data flows to the next handler. A handler that returns `false` aborts the chain and the caller receives `false`.

---

## File Structure

```
src/plugins/
├── types.ts        HookMap, HookHandler, HookRunner, Plugin, PluginContext, PluginRecord, PluginServices, Logger, LogLevel.
├── logger.ts       createLogger(name, level?) — console-based logger with level filtering.
├── hooks.ts        createHookRunner(opts?) — the event registry with chain/broadcast/timeout.
├── registry.ts     createPluginRegistry(hookRunner), registerPlugin, getPlugin, listPlugins, unregisterPlugin.
├── loader.ts       validatePluginModule, loadPlugin (dynamic import), discoverPlugins (scan dirs).
├── lifecycle.ts    createPluginContext, activatePlugin, deactivatePlugin, deactivateAll.
├── builtin.ts      createToolAuditLogger, createWriteGuard, BUILTIN_PLUGINS, registerBuiltinHooks.
├── index.ts        Barrel export of all public API.
└── *.test.ts       Co-located tests for each module.

src/core/
├── types.ts        MODIFIED: add optional `hookRunner?: HookRunner` to AgentDependencies.
├── tool-exec.ts    MODIFIED: add optional `hookRunner?` param to executeToolCall/executeToolCalls.
└── loop.ts         MODIFIED: inject provider/message hooks; pass hookRunner to executeToolCalls.
```

Dependencies: `plugins → shared` (types only). `plugins → tools, llm` (runtime wiring in lifecycle.ts). `core → plugins` (HookRunner type only, for AgentDependencies). No circular dependencies.

---

## Task 1: Plugin Types & Logger (`types.ts` + `logger.ts`)

**Files:**
- Create: `src/plugins/types.ts`
- Create: `src/plugins/logger.ts`
- Test: `src/plugins/logger.test.ts`

### types.ts

Pure type definitions for the entire plugin package. All types are `type` (not `interface`), discriminated unions use `_tag`, functions use context-first args.

```typescript
// src/plugins/types.ts
import type { AgentConfig } from '../shared/types/agent.js'
import type { Config } from '../shared/types/config.js'
import type {
  ChatMessage,
  ChatRequest,
  ProviderConfig,
  StreamChunk,
} from '../shared/types/llm.js'
import type { Message, Session } from '../shared/types/message.js'
import type { ToolContext, ToolDef, ToolResult } from '../shared/types/tool.js'

// ── Logger ──────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

type Logger = {
  debug: (msg: string, ...args: unknown[]) => void
  info: (msg: string, ...args: unknown[]) => void
  warn: (msg: string, ...args: unknown[]) => void
  error: (msg: string, ...args: unknown[]) => void
}

// ── Hook system ─────────────────────────────────────────────

/** Unified event map. `domain:before` = chain (can modify/abort); `domain:after` = broadcast. */
type HookMap = {
  'agent:start': { config: AgentConfig }
  'agent:end': Record<string, never>
  'tool:before': { tool: string; input: unknown; ctx: ToolContext }
  'tool:after': { tool: string; input: unknown; result: ToolResult; ctx: ToolContext }
  'provider:before': { request: ChatRequest }
  'provider:after': { request: ChatRequest; chunks: StreamChunk[] }
  'message:before': { messages: ChatMessage[] }
  'message:after': { message: Message }
  'session:create': { session: Session }
  'session:fork': { source: Session; fork: Session }
  'session:compact': { before: number; after: number }
  'config:resolve': { config: Config }
}

/** Hook handler. Returns T (possibly modified) or false (abort). void = passthrough. */
type HookHandler<T> = (data: T) => T | false | void | Promise<T | false | void>

/** Options for createHookRunner. */
type HookRunnerOptions = {
  /** Per-handler timeout in ms. Default 5000. */
  timeout?: number
  /** Logger for error/timeout warnings. Default: console. */
  logger?: Logger
}

/** Mutable event registry. Functions are context-first (runner as hidden state). */
type HookRunner = {
  on: <K extends keyof HookMap>(
    event: K,
    handler: HookHandler<HookMap[K]>,
    priority?: number,
  ) => void
  off: <K extends keyof HookMap>(event: K, handler: HookHandler<HookMap[K]>) => void
  runHooks: <K extends keyof HookMap>(event: K, data: HookMap[K]) => Promise<HookMap[K] | false>
  fireHooks: <K extends keyof HookMap>(event: K, data: HookMap[K]) => Promise<void>
  dispose: () => void
}

// ── Plugin ──────────────────────────────────────────────────

/** A process-level plugin. `setup` is called during activation; `dispose` during deactivation. */
type Plugin = {
  name: string
  version: string
  description?: string
  setup: (ctx: PluginContext) => void | Promise<void>
  dispose?: () => void | Promise<void>
}

/** Context passed to plugin.setup(). Delegates to real registries. */
type PluginContext = {
  registerTool: (tool: ToolDef) => void
  registerProvider: (provider: ProviderConfig) => void
  on: HookRunner['on']
  off: HookRunner['off']
  getConfig: () => Config
  getLogger: (name: string) => Logger
  onDispose: (handler: () => void | Promise<void>) => void
}

/** Runtime status of a loaded plugin. */
type PluginStatus = 'loaded' | 'active' | 'error' | 'inactive'

/** Internal record stored in PluginRegistry. */
type PluginRecord = {
  plugin: Plugin
  status: PluginStatus
  error?: string
  disposeHandlers: (() => void | Promise<void>)[]
}

/** Mutable plugin registry. */
type PluginRegistry = {
  plugins: Map<string, PluginRecord>
  hookRunner: HookRunner
}

/** Services needed to create PluginContext during activation. */
type PluginServices = {
  config: Config
  toolRegistry: unknown
  llmRegistry: unknown
}

export type {
  AgentConfig,
  ChatMessage,
  ChatRequest,
  Config,
  HookHandler,
  HookMap,
  HookRunner,
  HookRunnerOptions,
  Logger,
  LogLevel,
  Message,
  Plugin,
  PluginContext,
  PluginRecord,
  PluginRegistry,
  PluginServices,
  PluginStatus,
  ProviderConfig,
  Session,
  StreamChunk,
  ToolContext,
  ToolDef,
  ToolResult,
}
```

### logger.ts

```typescript
// src/plugins/logger.ts
import type { Logger, LogLevel } from './types.js'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
}

/** Create a named, level-filtered logger that writes to console. */
function createLogger(name: string, level: LogLevel = 'info'): Logger {
  const prefix = `[${name}]`
  const shouldLog = (target: LogLevel): boolean =>
    LEVEL_ORDER[level] <= LEVEL_ORDER[target]

  return {
    debug: (msg: string, ...args: unknown[]) => {
      if (shouldLog('debug')) console.debug(prefix, msg, ...args)
    },
    info: (msg: string, ...args: unknown[]) => {
      if (shouldLog('info')) console.info(prefix, msg, ...args)
    },
    warn: (msg: string, ...args: unknown[]) => {
      if (shouldLog('warn')) console.warn(prefix, msg, ...args)
    },
    error: (msg: string, ...args: unknown[]) => {
      if (shouldLog('error')) console.error(prefix, msg, ...args)
    },
  }
}

export { createLogger }
```

- [ ] **Step 1: Write `src/plugins/types.ts`** (code above, verbatim)

- [ ] **Step 2: Write `src/plugins/logger.ts`** (code above, verbatim)

- [ ] **Step 3: Write the failing test**

```typescript
// src/plugins/logger.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createLogger } from './logger.js'

describe('createLogger', () => {
  it('creates a logger with all 4 methods', () => {
    const logger = createLogger('test')
    expect(typeof logger.debug).toBe('function')
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.error).toBe('function')
  })

  it('logs info messages by default', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const logger = createLogger('test')
    logger.info('hello')
    expect(spy).toHaveBeenCalledWith('[test]', 'hello')
    spy.mockRestore()
  })

  it('filters out debug when level is info', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const logger = createLogger('test', 'info')
    logger.debug('hidden')
    expect(debugSpy).not.toHaveBeenCalled()
    debugSpy.mockRestore()
  })

  it('shows debug when level is debug', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const logger = createLogger('test', 'debug')
    logger.debug('visible')
    expect(debugSpy).toHaveBeenCalledWith('[test]', 'visible')
    debugSpy.mockRestore()
  })

  it('suppresses all output at silent level', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = createLogger('test', 'silent')
    logger.error('suppressed')
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('passes extra args to console methods', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger = createLogger('test')
    logger.warn('warning', { key: 'val' }, 42)
    expect(spy).toHaveBeenCalledWith('[test]', 'warning', { key: 'val' }, 42)
    spy.mockRestore()
  })
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/plugins/logger.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Verify typecheck**

Run: `pnpm typecheck`
Expected: No errors in `src/plugins/types.ts` or `src/plugins/logger.ts`

- [ ] **Step 6: Commit**

```bash
git add src/plugins/types.ts src/plugins/logger.ts src/plugins/logger.test.ts
git commit -m "feat(plugins): add plugin types and logger"
```

---

## Task 2: Hook Runner (`hooks.ts`)

**Files:**
- Create: `src/plugins/hooks.ts`
- Test: `src/plugins/hooks.test.ts`

The core of the plugin system: a priority-ordered event registry with chain execution (for `before` events), broadcast execution (for `after` events), timeout protection, and error isolation.

- [ ] **Step 1: Write the failing test**

```typescript
// src/plugins/hooks.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createHookRunner } from './hooks.js'
import type { HookMap } from './types.js'

describe('createHookRunner', () => {
  it('returns a HookRunner with all methods', () => {
    const runner = createHookRunner()
    expect(typeof runner.on).toBe('function')
    expect(typeof runner.off).toBe('function')
    expect(typeof runner.runHooks).toBe('function')
    expect(typeof runner.fireHooks).toBe('function')
    expect(typeof runner.dispose).toBe('function')
  })

  it('runHooks returns original data when no handlers registered', async () => {
    const runner = createHookRunner()
    const result = await runner.runHooks('tool:before', {
      tool: 'read',
      input: { path: '/a' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(result).not.toBe(false)
  })

  it('runHooks calls a single handler', async () => {
    const runner = createHookRunner()
    const handler = vi.fn((data) => data)
    runner.on('tool:before', handler)
    const data = {
      tool: 'read',
      input: { path: '/a' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    }
    await runner.runHooks('tool:before', data)
    expect(handler).toHaveBeenCalledWith(data)
  })

  it('runHooks chains handlers in priority order (lower = first)', async () => {
    const runner = createHookRunner()
    const calls: string[] = []
    runner.on('tool:before', () => {
      calls.push('second')
    }, 200)
    runner.on('tool:before', () => {
      calls.push('first')
    }, 50)
    runner.on('tool:before', () => {
      calls.push('third')
    }, 300)
    await runner.runHooks('tool:before', {
      tool: 'read',
      input: {},
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(calls).toEqual(['first', 'second', 'third'])
  })

  it('runHooks passes modified data through the chain', async () => {
    const runner = createHookRunner()
    runner.on('tool:before', (data) => {
      return { ...data, input: { ...data.input as object, modified: true } }
    }, 100)
    runner.on('tool:before', (data) => {
      return { ...data, input: { ...data.input as object, second: true } }
    }, 200)
    const result = await runner.runHooks('tool:before', {
      tool: 'write',
      input: { path: '/a' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(result).not.toBe(false)
    if (result !== false) {
      expect(result.input).toEqual({ path: '/a', modified: true, second: true })
    }
  })

  it('runHooks aborts chain when handler returns false', async () => {
    const runner = createHookRunner()
    const secondHandler = vi.fn()
    runner.on('tool:before', () => false, 100)
    runner.on('tool:before', secondHandler, 200)
    const result = await runner.runHooks('tool:before', {
      tool: 'write',
      input: {},
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(result).toBe(false)
    expect(secondHandler).not.toHaveBeenCalled()
  })

  it('runHooks treats void return as passthrough (no modification)', async () => {
    const runner = createHookRunner()
    const originalData = {
      tool: 'read',
      input: { path: '/a' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    }
    runner.on('tool:before', () => {
      // returns void — should not modify data
    })
    const result = await runner.runHooks('tool:before', originalData)
    expect(result).toEqual(originalData)
  })

  it('runHooks supports async handlers', async () => {
    const runner = createHookRunner()
    runner.on('tool:before', async (data) => {
      await new Promise((r) => setTimeout(r, 10))
      return { ...data, input: { ...data.input as object, async: true } }
    })
    const result = await runner.runHooks('tool:before', {
      tool: 'read',
      input: {},
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(result).not.toBe(false)
    if (result !== false) {
      expect(result.input).toEqual({ async: true })
    }
  })

  it('runHooks isolates errors — logs warning, continues with last good data', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runner = createHookRunner()
    runner.on('tool:before', () => {
      throw new Error('boom')
    }, 100)
    const afterHandler = vi.fn((data) => data)
    runner.on('tool:before', afterHandler, 200)
    const result = await runner.runHooks('tool:before', {
      tool: 'read',
      input: { original: true },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(result).not.toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    expect(afterHandler).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('fireHooks calls all handlers (broadcast)', async () => {
    const runner = createHookRunner()
    const h1 = vi.fn()
    const h2 = vi.fn()
    runner.on('tool:after', h1)
    runner.on('tool:after', h2)
    const data = {
      tool: 'read',
      input: {},
      result: { _tag: 'success' as const, output: 'ok' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    }
    await runner.fireHooks('tool:after', data)
    expect(h1).toHaveBeenCalledWith(data)
    expect(h2).toHaveBeenCalledWith(data)
  })

  it('fireHooks ignores handler return values', async () => {
    const runner = createHookRunner()
    const handler = vi.fn(() => 'ignored-value')
    runner.on('tool:after', handler)
    await runner.fireHooks('tool:after', {
      tool: 'read',
      input: {},
      result: { _tag: 'success' as const, output: 'ok' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(handler).toHaveBeenCalled()
  })

  it('fireHooks isolates errors — one failing handler does not affect others', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runner = createHookRunner()
    const goodHandler = vi.fn()
    runner.on('tool:after', () => {
      throw new Error('boom')
    })
    runner.on('tool:after', goodHandler)
    await runner.fireHooks('tool:after', {
      tool: 'read',
      input: {},
      result: { _tag: 'success' as const, output: 'ok' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(goodHandler).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('off removes a specific handler', async () => {
    const runner = createHookRunner()
    const handler = vi.fn()
    runner.on('tool:before', handler)
    runner.off('tool:before', handler)
    await runner.runHooks('tool:before', {
      tool: 'read',
      input: {},
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('dispose removes all handlers', async () => {
    const runner = createHookRunner()
    const handler = vi.fn()
    runner.on('tool:before', handler)
    runner.dispose()
    await runner.runHooks('tool:before', {
      tool: 'read',
      input: {},
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('timeout: handler exceeding timeout is skipped in chain mode', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runner = createHookRunner({ timeout: 100 })
    const nextHandler = vi.fn((data) => data)
    runner.on('tool:before', async () => {
      await new Promise((r) => setTimeout(r, 500))
    }, 100)
    runner.on('tool:before', nextHandler, 200)
    const promise = runner.runHooks('tool:before', {
      tool: 'read',
      input: {},
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result).not.toBe(false)
    expect(nextHandler).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/plugins/hooks.test.ts`
Expected: FAIL — `createHookRunner` is not defined (module not found)

- [ ] **Step 3: Write the implementation**

```typescript
// src/plugins/hooks.ts
import type { HookHandler, HookMap, HookRunner, HookRunnerOptions, Logger } from './types.js'
import { createLogger } from './logger.js'

type ErasedHandler = (data: unknown) => unknown | false | Promise<unknown | false | void>

type Registration = {
  handler: ErasedHandler
  priority: number
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Hook handler timed out after ${ms}ms`)), ms)
    promise.then(
      (val) => {
        clearTimeout(timer)
        resolve(val)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function sortByPriority(regs: Registration[]): Registration[] {
  return regs.slice().sort((a, b) => a.priority - b.priority)
}

function createHookRunner(opts?: HookRunnerOptions): HookRunner {
  const timeout = opts?.timeout ?? 5000
  const logger: Logger = opts?.logger ?? createLogger('hooks')
  const handlers = new Map<string, Registration[]>()

  const on = (
    event: keyof HookMap,
    handler: ErasedHandler,
    priority: number,
  ): void => {
    const key = event as string
    const regs = handlers.get(key) ?? []
    regs.push({ handler, priority })
    handlers.set(key, regs)
  }

  const off = (event: keyof HookMap, handler: ErasedHandler): void => {
    const key = event as string
    const regs = handlers.get(key)
    if (!regs) return
    const filtered = regs.filter((r) => r.handler !== handler)
    handlers.set(key, filtered)
  }

  const runHooks = async <K extends keyof HookMap>(
    event: K,
    data: HookMap[K],
  ): Promise<HookMap[K] | false> => {
    const regs = handlers.get(event as string)
    if (!regs || regs.length === 0) return data
    let current: unknown = data
    for (const reg of sortByPriority(regs)) {
      try {
        const result = await withTimeout(
          Promise.resolve(reg.handler(current)),
          timeout,
        )
        if (result === false) return false
        if (result !== undefined) current = result
      } catch (err) {
        logger.warn(`Handler for "${String(event)}" failed:`, err)
      }
    }
    return current as HookMap[K]
  }

  const fireHooks = async <K extends keyof HookMap>(
    event: K,
    data: HookMap[K],
  ): Promise<void> => {
    const regs = handlers.get(event as string)
    if (!regs || regs.length === 0) return
    await Promise.allSettled(
      sortByPriority(regs).map(async (reg) => {
        try {
          await withTimeout(Promise.resolve(reg.handler(data)), timeout)
        } catch (err) {
          logger.warn(`Handler for "${String(event)}" failed:`, err)
        }
      }),
    )
  }

  const dispose = (): void => {
    handlers.clear()
  }

  return {
    on: ((event: keyof HookMap, handler: ErasedHandler, priority = 100) =>
      on(event, handler, priority)) as HookRunner['on'],
    off: off as HookRunner['off'],
    runHooks: runHooks as HookRunner['runHooks'],
    fireHooks: fireHooks as HookRunner['fireHooks'],
    dispose,
  }
}

export { createHookRunner }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/plugins/hooks.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add src/plugins/hooks.ts src/plugins/hooks.test.ts
git commit -m "feat(plugins): add hook runner with chain/broadcast/timeout"
```

---

## Task 3: Plugin Registry (`registry.ts`)

**Files:**
- Create: `src/plugins/registry.ts`
- Test: `src/plugins/registry.test.ts`

The plugin registry stores loaded plugins and their records. It holds a reference to the shared `HookRunner`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/plugins/registry.test.ts
import { describe, it, expect } from 'vitest'
import { createPluginRegistry, registerPlugin, getPlugin, listPlugins, unregisterPlugin } from './registry.js'
import { createHookRunner } from './hooks.js'
import type { Plugin } from './types.js'

function makePlugin(name: string): Plugin {
  return {
    name,
    version: '1.0.0',
    setup: () => {},
  }
}

describe('plugin registry', () => {
  it('createPluginRegistry returns a registry with hookRunner', () => {
    const hookRunner = createHookRunner()
    const registry = createPluginRegistry(hookRunner)
    expect(registry.hookRunner).toBe(hookRunner)
    expect(registry.plugins.size).toBe(0)
  })

  it('registerPlugin adds a plugin with status loaded', () => {
    const registry = createPluginRegistry(createHookRunner())
    registerPlugin(registry, makePlugin('alpha'))
    expect(registry.plugins.size).toBe(1)
    expect(registry.plugins.get('alpha')?.status).toBe('loaded')
  })

  it('getPlugin returns the record by name', () => {
    const registry = createPluginRegistry(createHookRunner())
    registerPlugin(registry, makePlugin('beta'))
    const record = getPlugin(registry, 'beta')
    expect(record).toBeDefined()
    expect(record?.plugin.name).toBe('beta')
  })

  it('getPlugin returns undefined for unknown plugin', () => {
    const registry = createPluginRegistry(createHookRunner())
    expect(getPlugin(registry, 'nonexistent')).toBeUndefined()
  })

  it('listPlugins returns all plugin records', () => {
    const registry = createPluginRegistry(createHookRunner())
    registerPlugin(registry, makePlugin('a'))
    registerPlugin(registry, makePlugin('b'))
    const list = listPlugins(registry)
    expect(list).toHaveLength(2)
    expect(list.map((r) => r.plugin.name)).toContain('a')
    expect(list.map((r) => r.plugin.name)).toContain('b')
  })

  it('unregisterPlugin removes a plugin and returns true', () => {
    const registry = createPluginRegistry(createHookRunner())
    registerPlugin(registry, makePlugin('gamma'))
    const removed = unregisterPlugin(registry, 'gamma')
    expect(removed).toBe(true)
    expect(registry.plugins.has('gamma')).toBe(false)
  })

  it('unregisterPlugin returns false for unknown plugin', () => {
    const registry = createPluginRegistry(createHookRunner())
    expect(unregisterPlugin(registry, 'unknown')).toBe(false)
  })

  it('registerPlugin replaces existing plugin with same name', () => {
    const registry = createPluginRegistry(createHookRunner())
    registerPlugin(registry, makePlugin('dup'))
    registerPlugin(registry, makePlugin('dup'))
    expect(registry.plugins.size).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/plugins/registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/plugins/registry.ts
import type { Plugin, PluginRecord, PluginRegistry, HookRunner } from './types.js'

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/plugins/registry.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/plugins/registry.ts src/plugins/registry.test.ts
git commit -m "feat(plugins): add plugin registry"
```

---

## Task 4: Plugin Lifecycle (`lifecycle.ts`)

**Files:**
- Create: `src/plugins/lifecycle.ts`
- Test: `src/plugins/lifecycle.test.ts`

Wires `PluginContext` to real registries, and manages plugin activation (calling `setup`) and deactivation (calling dispose handlers).

- [ ] **Step 1: Write the failing test**

```typescript
// src/plugins/lifecycle.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createPluginRegistry, registerPlugin } from './registry.js'
import { createHookRunner } from './hooks.js'
import { activatePlugin, deactivatePlugin, deactivateAll, createPluginContext } from './lifecycle.js'
import { createToolRegistry } from '../tools/registry.js'
import { createRegistry as createLLMRegistry } from '../llm/registry.js'
import { DEFAULT_CONFIG } from '../core/config.js'
import type { Plugin, PluginServices } from './types.js'

function makeServices(): { services: PluginServices; toolRegistry: ReturnType<typeof createToolRegistry> } {
  const toolRegistry = createToolRegistry()
  const llmRegistry = createLLMRegistry()
  return {
    services: { config: DEFAULT_CONFIG, toolRegistry, llmRegistry },
    toolRegistry,
  }
}

describe('createPluginContext', () => {
  it('creates context with all required methods', () => {
    const { services, toolRegistry } = makeServices()
    const hookRunner = createHookRunner()
    const disposeHandlers: (() => void | Promise<void>)[] = []
    const ctx = createPluginContext(services, hookRunner, disposeHandlers)
    expect(typeof ctx.registerTool).toBe('function')
    expect(typeof ctx.registerProvider).toBe('function')
    expect(typeof ctx.on).toBe('function')
    expect(typeof ctx.off).toBe('function')
    expect(typeof ctx.getConfig).toBe('function')
    expect(typeof ctx.getLogger).toBe('function')
    expect(typeof ctx.onDispose).toBe('function')
  })

  it('registerTool delegates to the tool registry', () => {
    const { services, toolRegistry } = makeServices()
    const ctx = createPluginContext(services, createHookRunner(), [])
    const tool = {
      name: 'my-tool',
      description: 'test',
      parameters: { type: 'object' as const, properties: {} },
      permission: 'auto' as const,
      execute: async () => ({ _tag: 'success' as const, output: 'ok' }),
    }
    ctx.registerTool(tool)
    expect(toolRegistry.tools.has('my-tool')).toBe(true)
  })

  it('on delegates to the hook runner', async () => {
    const { services } = makeServices()
    const hookRunner = createHookRunner()
    const ctx = createPluginContext(services, hookRunner, [])
    const handler = vi.fn((data) => data)
    ctx.on('tool:before', handler)
    await hookRunner.runHooks('tool:before', {
      tool: 'read',
      input: {},
      ctx: { cwd: '/', session: { id: 's', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(handler).toHaveBeenCalled()
  })

  it('getConfig returns the config', () => {
    const { services } = makeServices()
    const ctx = createPluginContext(services, createHookRunner(), [])
    expect(ctx.getConfig()).toBe(DEFAULT_CONFIG)
  })

  it('getLogger returns a logger with the plugin name prefix', () => {
    const { services } = makeServices()
    const ctx = createPluginContext(services, createHookRunner(), [])
    const logger = ctx.getLogger('my-plugin')
    expect(typeof logger.info).toBe('function')
  })

  it('onDispose adds handler to the dispose array', () => {
    const { services } = makeServices()
    const disposeHandlers: (() => void | Promise<void>)[] = []
    const ctx = createPluginContext(services, createHookRunner(), disposeHandlers)
    const handler = vi.fn()
    ctx.onDispose(handler)
    expect(disposeHandlers).toContain(handler)
  })
})

describe('activatePlugin', () => {
  it('calls plugin.setup with a PluginContext and sets status to active', async () => {
    const { services } = makeServices()
    const hookRunner = createHookRunner()
    const registry = createPluginRegistry(hookRunner)
    const setupFn = vi.fn()
    const plugin: Plugin = { name: 'test', version: '1.0.0', setup: setupFn }
    registerPlugin(registry, plugin)
    await activatePlugin(registry, plugin, services)
    expect(setupFn).toHaveBeenCalledOnce()
    expect(registry.plugins.get('test')?.status).toBe('active')
  })

  it('supports async setup', async () => {
    const { services } = makeServices()
    const registry = createPluginRegistry(createHookRunner())
    let setupDone = false
    const plugin: Plugin = {
      name: 'async-test',
      version: '1.0.0',
      setup: async () => {
        await new Promise((r) => setTimeout(r, 10))
        setupDone = true
      },
    }
    registerPlugin(registry, plugin)
    await activatePlugin(registry, plugin, services)
    expect(setupDone).toBe(true)
    expect(registry.plugins.get('async-test')?.status).toBe('active')
  })

  it('sets status to error if setup throws', async () => {
    const { services } = makeServices()
    const registry = createPluginRegistry(createHookRunner())
    const plugin: Plugin = {
      name: 'bad',
      version: '1.0.0',
      setup: () => {
        throw new Error('setup failed')
      },
    }
    registerPlugin(registry, plugin)
    await activatePlugin(registry, plugin, services)
    const record = registry.plugins.get('bad')
    expect(record?.status).toBe('error')
    expect(record?.error).toContain('setup failed')
  })

  it('does not activate already-active plugin', async () => {
    const { services } = makeServices()
    const registry = createPluginRegistry(createHookRunner())
    const setupFn = vi.fn()
    const plugin: Plugin = { name: 'once', version: '1.0.0', setup: setupFn }
    registerPlugin(registry, plugin)
    await activatePlugin(registry, plugin, services)
    await activatePlugin(registry, plugin, services)
    expect(setupFn).toHaveBeenCalledOnce()
  })
})

describe('deactivatePlugin', () => {
  it('calls dispose handlers and sets status to inactive', async () => {
    const { services } = makeServices()
    const registry = createPluginRegistry(createHookRunner())
    const disposeFn = vi.fn()
    const plugin: Plugin = {
      name: 'disposable',
      version: '1.0.0',
      setup: (ctx) => {
        ctx.onDispose(disposeFn)
      },
    }
    registerPlugin(registry, plugin)
    await activatePlugin(registry, plugin, services)
    await deactivatePlugin(registry, 'disposable')
    expect(disposeFn).toHaveBeenCalledOnce()
    expect(registry.plugins.get('disposable')?.status).toBe('inactive')
  })

  it('calls plugin.dispose if defined', async () => {
    const { services } = makeServices()
    const registry = createPluginRegistry(createHookRunner())
    const disposeFn = vi.fn()
    const plugin: Plugin = {
      name: 'with-dispose',
      version: '1.0.0',
      setup: () => {},
      dispose: disposeFn,
    }
    registerPlugin(registry, plugin)
    await activatePlugin(registry, plugin, services)
    await deactivatePlugin(registry, 'with-dispose')
    expect(disposeFn).toHaveBeenCalledOnce()
  })

  it('is a no-op for unknown plugin', async () => {
    const registry = createPluginRegistry(createHookRunner())
    await expect(deactivatePlugin(registry, 'unknown')).resolves.toBeUndefined()
  })
})

describe('deactivateAll', () => {
  it('deactivates all active plugins', async () => {
    const { services } = makeServices()
    const registry = createPluginRegistry(createHookRunner())
    const d1 = vi.fn()
    const d2 = vi.fn()
    const p1: Plugin = { name: 'p1', version: '1.0.0', setup: (ctx) => ctx.onDispose(d1) }
    const p2: Plugin = { name: 'p2', version: '1.0.0', setup: (ctx) => ctx.onDispose(d2) }
    registerPlugin(registry, p1)
    registerPlugin(registry, p2)
    await activatePlugin(registry, p1, services)
    await activatePlugin(registry, p2, services)
    await deactivateAll(registry)
    expect(d1).toHaveBeenCalledOnce()
    expect(d2).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/plugins/lifecycle.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/plugins/lifecycle.ts
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
import type { ProviderConfig } from '../shared/types/llm.js'
import { registerTool } from '../tools/registry.js'
import type { ToolRegistry } from '../tools/types.js'
import { registerProvider as registerLLMProvider } from '../llm/registry.js'
import type { Registry as LLMRegistry } from '../llm/registry.js'

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/plugins/lifecycle.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add src/plugins/lifecycle.ts src/plugins/lifecycle.test.ts
git commit -m "feat(plugins): add plugin lifecycle (activate/deactivate)"
```

---

## Task 5: Plugin Loader (`loader.ts`)

**Files:**
- Create: `src/plugins/loader.ts`
- Test: `src/plugins/loader.test.ts`

Discovers plugins from filesystem directories and loads them via dynamic `import()`. Also provides `validatePluginModule` for type-safe validation of imported modules.

- [ ] **Step 1: Write the failing test**

```typescript
// src/plugins/loader.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePluginModule, loadPlugin, discoverPlugins } from './loader.js'
import type { Plugin } from './types.js'

describe('validatePluginModule', () => {
  it('accepts a valid plugin object', () => {
    const mod = {
      default: {
        name: 'test',
        version: '1.0.0',
        setup: () => {},
      },
    }
    const result = validatePluginModule(mod)
    expect(result.valid).toBe(true)
    expect(result.plugin?.name).toBe('test')
  })

  it('accepts a module without default export (named export)', () => {
    const plugin: Plugin = { name: 'named', version: '1.0.0', setup: () => {} }
    const result = validatePluginModule(plugin)
    expect(result.valid).toBe(true)
    expect(result.plugin?.name).toBe('named')
  })

  it('rejects a module missing name', () => {
    const result = validatePluginModule({
      default: { version: '1.0.0', setup: () => {} },
    })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('name')
  })

  it('rejects a module missing version', () => {
    const result = validatePluginModule({
      default: { name: 'test', setup: () => {} },
    })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('version')
  })

  it('rejects a module missing setup', () => {
    const result = validatePluginModule({
      default: { name: 'test', version: '1.0.0' },
    })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('setup')
  })

  it('rejects a module where setup is not a function', () => {
    const result = validatePluginModule({
      default: { name: 'test', version: '1.0.0', setup: 'not-a-fn' },
    })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('setup')
  })
})

describe('loadPlugin', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c0de-plugin-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('loads a valid plugin from a JS file', async () => {
    const pluginPath = join(tempDir, 'my-plugin.js')
    writeFileSync(
      pluginPath,
      `export default { name: 'fs-plugin', version: '1.0.0', setup() {} };\n`,
    )
    const plugin = await loadPlugin(pluginPath)
    expect(plugin.name).toBe('fs-plugin')
    expect(plugin.version).toBe('1.0.0')
  })

  it('throws on invalid plugin module', async () => {
    const pluginPath = join(tempDir, 'bad-plugin.js')
    writeFileSync(pluginPath, `export default { name: 'bad' };\n`)
    await expect(loadPlugin(pluginPath)).rejects.toThrow()
  })
})

describe('discoverPlugins', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c0de-discover-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('discovers plugins from project .c0de/plugins/ directory', async () => {
    const pluginsDir = join(tempDir, '.c0de', 'plugins')
    mkdirSync(join(pluginsDir, 'plugin-a'), { recursive: true })
    writeFileSync(
      join(pluginsDir, 'plugin-a', 'index.js'),
      `export default { name: 'plugin-a', version: '1.0.0', setup() {} };\n`,
    )
    mkdirSync(join(pluginsDir, 'plugin-b'), { recursive: true })
    writeFileSync(
      join(pluginsDir, 'plugin-b', 'index.js'),
      `export default { name: 'plugin-b', version: '1.0.0', setup() {} };\n`,
    )
    const found = await discoverPlugins(tempDir)
    expect(found).toHaveLength(2)
    expect(found.map((f) => f.plugin.name).sort()).toEqual(['plugin-a', 'plugin-b'])
  })

  it('returns empty array when no plugins directory exists', async () => {
    const found = await discoverPlugins(tempDir)
    expect(found).toEqual([])
  })

  it('skips directories without index.js', async () => {
    const pluginsDir = join(tempDir, '.c0de', 'plugins')
    mkdirSync(join(pluginsDir, 'empty-plugin'), { recursive: true })
    const found = await discoverPlugins(tempDir)
    expect(found).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/plugins/loader.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/plugins/loader.ts
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from './types.js'

type ValidationResult =
  | { valid: true; plugin: Plugin }
  | { valid: false; error: string }

function validatePluginModule(mod: unknown): ValidationResult {
  const candidate = (mod as { default?: unknown })?.default ?? mod
  if (typeof candidate !== 'object' || candidate === null) {
    return { valid: false, error: 'Plugin module must export an object' }
  }
  const obj = candidate as Record<string, unknown>
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    return { valid: false, error: 'Plugin must have a non-empty "name" string' }
  }
  if (typeof obj.version !== 'string') {
    return { valid: false, error: 'Plugin must have a "version" string' }
  }
  if (typeof obj.setup !== 'function') {
    return { valid: false, error: 'Plugin must have a "setup" function' }
  }
  return { valid: true, plugin: obj as unknown as Plugin }
}

async function loadPlugin(path: string): Promise<Plugin> {
  const mod = await import(path)
  const result = validatePluginModule(mod)
  if (!result.valid) {
    throw new Error(`Invalid plugin at ${path}: ${result.error}`)
  }
  return result.plugin
}

function scanPluginDir(dir: string): { name: string; path: string }[] {
  if (!existsSync(dir)) return []
  const entries = readdirSync(dir)
  const plugins: { name: string; path: string }[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    try {
      if (!statSync(fullPath).isDirectory()) continue
    } catch {
      continue
    }
    const indexPath = join(fullPath, 'index.js')
    if (existsSync(indexPath)) {
      plugins.push({ name: entry, path: fullPath })
    }
  }
  return plugins
}

async function discoverPlugins(
  projectDir: string,
): Promise<{ name: string; path: string; plugin: Plugin }[]> {
  const projectPluginsDir = join(projectDir, '.c0de', 'plugins')
  const globalPluginsDir = join(homedir(), '.c0de', 'plugins')

  const discovered = [...scanPluginDir(projectPluginsDir), ...scanPluginDir(globalPluginsDir)]

  const results: { name: string; path: string; plugin: Plugin }[] = []
  for (const entry of discovered) {
    try {
      const plugin = await loadPlugin(join(entry.path, 'index.js'))
      results.push({ name: entry.name, path: entry.path, plugin })
    } catch {
      // Skip plugins that fail to load
    }
  }
  return results
}

export { discoverPlugins, loadPlugin, validatePluginModule }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/plugins/loader.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/plugins/loader.ts src/plugins/loader.test.ts
git commit -m "feat(plugins): add plugin loader and discovery"
```

---

## Task 6: Builtin Plugins (`builtin.ts`)

**Files:**
- Create: `src/plugins/builtin.ts`
- Test: `src/plugins/builtin.test.ts`

Two built-in plugins that demonstrate the hook system: `tool-audit-log` (logs tool activity) and `write-guard` (warns before overwriting existing files).

- [ ] **Step 1: Write the failing test**

```typescript
// src/plugins/builtin.test.ts
import { describe, it, expect, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { createHookRunner } from './hooks.js'
import { createPluginRegistry, registerPlugin } from './registry.js'
import { activatePlugin, deactivateAll } from './lifecycle.js'
import { createToolRegistry } from '../tools/registry.js'
import { createRegistry as createLLMRegistry } from '../llm/registry.js'
import { DEFAULT_CONFIG } from '../core/config.js'
import {
  createToolAuditLogger,
  createWriteGuard,
  BUILTIN_PLUGINS,
  registerBuiltinHooks,
} from './builtin.js'
import type { PluginServices } from './types.js'

function makeServices(): PluginServices {
  return {
    config: DEFAULT_CONFIG,
    toolRegistry: createToolRegistry(),
    llmRegistry: createLLMRegistry(),
  }
}

describe('createToolAuditLogger', () => {
  it('returns a valid Plugin', () => {
    const plugin = createToolAuditLogger()
    expect(plugin.name).toBe('tool-audit-log')
    expect(plugin.version).toBe('1.0.0')
    expect(typeof plugin.setup).toBe('function')
  })

  it('logs tool:before events when activated', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const services = makeServices()
    const hookRunner = createHookRunner()
    const registry = createPluginRegistry(hookRunner)
    const plugin = createToolAuditLogger()
    registerPlugin(registry, plugin)
    await activatePlugin(registry, plugin, services)

    await hookRunner.runHooks('tool:before', {
      tool: 'read',
      input: { path: '/test' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(infoSpy).toHaveBeenCalled()
    infoSpy.mockRestore()
    await deactivateAll(registry)
  })

  it('logs tool:after events when activated', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const services = makeServices()
    const hookRunner = createHookRunner()
    const registry = createPluginRegistry(hookRunner)
    const plugin = createToolAuditLogger()
    registerPlugin(registry, plugin)
    await activatePlugin(registry, plugin, services)

    await hookRunner.fireHooks('tool:after', {
      tool: 'write',
      input: { path: '/test' },
      result: { _tag: 'success', output: 'done' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(infoSpy).toHaveBeenCalled()
    infoSpy.mockRestore()
    await deactivateAll(registry)
  })
})

describe('createWriteGuard', () => {
  it('returns a valid Plugin', () => {
    const plugin = createWriteGuard()
    expect(plugin.name).toBe('write-guard')
    expect(plugin.version).toBe('1.0.0')
  })

  it('warns when write tool targets an existing file', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const services = makeServices()
    const hookRunner = createHookRunner()
    const registry = createPluginRegistry(hookRunner)
    registerPlugin(registry, createWriteGuard())
    await activatePlugin(registry, createWriteGuard(), services)

    // Use a file we know exists: package.json
    await hookRunner.runHooks('tool:before', {
      tool: 'write',
      input: { path: 'package.json' },
      ctx: { cwd: process.cwd(), session: { id: 's1', cwd: process.cwd() }, abort: new AbortController().signal },
    })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
    await deactivateAll(registry)
  })

  it('does not warn for non-existent files', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const services = makeServices()
    const hookRunner = createHookRunner()
    const registry = createPluginRegistry(hookRunner)
    registerPlugin(registry, createWriteGuard())
    await activatePlugin(registry, createWriteGuard(), services)

    await hookRunner.runHooks('tool:before', {
      tool: 'write',
      input: { path: '/nonexistent/path/file.txt' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
    await deactivateAll(registry)
  })

  it('passes through data unmodified (does not abort write)', async () => {
    const services = makeServices()
    const hookRunner = createHookRunner()
    const registry = createPluginRegistry(hookRunner)
    registerPlugin(registry, createWriteGuard())
    await activatePlugin(registry, createWriteGuard(), services)

    const originalData = {
      tool: 'write',
      input: { path: 'package.json' },
      ctx: { cwd: process.cwd(), session: { id: 's1', cwd: process.cwd() }, abort: new AbortController().signal },
    }
    const result = await hookRunner.runHooks('tool:before', originalData)
    expect(result).not.toBe(false)
    expect(result).toEqual(originalData)
    await deactivateAll(registry)
  })
})

describe('BUILTIN_PLUGINS', () => {
  it('contains both builtin plugins', () => {
    expect(BUILTIN_PLUGINS).toHaveLength(2)
    expect(BUILTIN_PLUGINS.map((p) => p.name)).toContain('tool-audit-log')
    expect(BUILTIN_PLUGINS.map((p) => p.name)).toContain('write-guard')
  })
})

describe('registerBuiltinHooks', () => {
  it('registers specified builtin plugins into a registry', async () => {
    const services = makeServices()
    const hookRunner = createHookRunner()
    const registry = createPluginRegistry(hookRunner)
    await registerBuiltinHooks(registry, services, ['tool-audit-log'])
    expect(registry.plugins.size).toBe(1)
    expect(registry.plugins.get('tool-audit-log')?.status).toBe('active')
  })

  it('registers all builtins when no names specified', async () => {
    const services = makeServices()
    const registry = createPluginRegistry(createHookRunner())
    await registerBuiltinHooks(registry, services)
    expect(registry.plugins.size).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/plugins/builtin.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/plugins/builtin.ts
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { createLogger } from './logger.js'
import { activatePlugin } from './lifecycle.js'
import { registerPlugin } from './registry.js'
import type { Plugin, PluginRegistry, PluginServices } from './types.js'

function createToolAuditLogger(): Plugin {
  const logger = createLogger('tool-audit')
  return {
    name: 'tool-audit-log',
    version: '1.0.0',
    description: 'Logs all tool execution activity',
    setup: (ctx) => {
      ctx.on('tool:before', (data) => {
        logger.info(`tool:before → ${data.tool}`, { input: data.input })
      })
      ctx.on('tool:after', (data) => {
        const status = data.result._tag
        logger.info(`tool:after ← ${data.tool} [${status}]`)
      })
    },
  }
}

function createWriteGuard(): Plugin {
  const logger = createLogger('write-guard')
  return {
    name: 'write-guard',
    version: '1.0.0',
    description: 'Warns before overwriting existing files',
    setup: (ctx) => {
      ctx.on('tool:before', (data) => {
        if (data.tool !== 'write' && data.tool !== 'edit') return
        const input = data.input as { path?: string; file?: string } | undefined
        const rawPath = input?.path ?? input?.file
        if (typeof rawPath !== 'string') return
        const fullPath = isAbsolute(rawPath) ? rawPath : resolve(data.ctx.cwd, rawPath)
        if (existsSync(fullPath)) {
          logger.warn(`Overwriting existing file: ${fullPath}`)
        }
      }, 50)
    },
  }
}

const BUILTIN_PLUGINS: Plugin[] = [createToolAuditLogger(), createWriteGuard()]

async function registerBuiltinHooks(
  registry: PluginRegistry,
  services: PluginServices,
  names?: string[],
): Promise<void> {
  const selected = names
    ? BUILTIN_PLUGINS.filter((p) => names.includes(p.name))
    : BUILTIN_PLUGINS
  for (const plugin of selected) {
    registerPlugin(registry, plugin)
    await activatePlugin(registry, plugin, services)
  }
}

export { BUILTIN_PLUGINS, createToolAuditLogger, createWriteGuard, registerBuiltinHooks }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/plugins/builtin.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/plugins/builtin.ts src/plugins/builtin.test.ts
git commit -m "feat(plugins): add builtin hooks (audit-log, write-guard)"
```

---

## Task 7: Barrel Export (`index.ts`)

**Files:**
- Modify: `src/plugins/index.ts`
- Test: `src/plugins/index.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/plugins/index.test.ts
import { describe, it, expect } from 'vitest'
import * as plugins from './index.js'

describe('plugins barrel export', () => {
  it('exports createHookRunner', () => {
    expect(typeof plugins.createHookRunner).toBe('function')
  })

  it('exports createPluginRegistry', () => {
    expect(typeof plugins.createPluginRegistry).toBe('function')
  })

  it('exports lifecycle functions', () => {
    expect(typeof plugins.activatePlugin).toBe('function')
    expect(typeof plugins.deactivatePlugin).toBe('function')
    expect(typeof plugins.deactivateAll).toBe('function')
  })

  it('exports loader functions', () => {
    expect(typeof plugins.discoverPlugins).toBe('function')
    expect(typeof plugins.loadPlugin).toBe('function')
  })

  it('exports builtin hooks', () => {
    expect(typeof plugins.registerBuiltinHooks).toBe('function')
    expect(typeof plugins.createToolAuditLogger).toBe('function')
    expect(typeof plugins.createWriteGuard).toBe('function')
  })

  it('exports createLogger', () => {
    expect(typeof plugins.createLogger).toBe('function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/plugins/index.test.ts`
Expected: FAIL — barrel doesn't export the functions yet

- [ ] **Step 3: Write the barrel**

```typescript
// src/plugins/index.ts
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

export { createLogger } from './logger.js'
export { createHookRunner } from './hooks.js'
export {
  createPluginRegistry,
  getPlugin,
  listPlugins,
  registerPlugin,
  unregisterPlugin,
} from './registry.js'
export { activatePlugin, createPluginContext, deactivateAll, deactivatePlugin } from './lifecycle.js'
export { discoverPlugins, loadPlugin, validatePluginModule } from './loader.js'
export {
  BUILTIN_PLUGINS,
  createToolAuditLogger,
  createWriteGuard,
  registerBuiltinHooks,
} from './builtin.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/plugins/index.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run all plugin tests together**

Run: `pnpm test src/plugins/`
Expected: All plugin tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/plugins/index.ts src/plugins/index.test.ts
git commit -m "feat(plugins): add barrel export"
```

---

## Task 8: Core Integration — AgentDependencies (`core/types.ts`)

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/types.test.ts`

Add an optional `hookRunner` field to `AgentDependencies` so the loop can emit hooks. This is backward-compatible — existing tests don't set `hookRunner` and work unchanged.

- [ ] **Step 1: Read the current `src/core/types.ts` to find the `AgentDependencies` definition**

The `AgentDependencies` type is at the top of the file. It currently has: `db`, `llmRegistry`, `toolRegistry`, `permission`, `config`, `cwd`.

- [ ] **Step 2: Modify `src/core/types.ts`**

Add the import and field. The import goes at the top with the other type imports. The field is added to the `AgentDependencies` type.

Add this import after the existing `import type { Config }` line:

```typescript
import type { HookRunner } from '../plugins/types.js'
```

Add `hookRunner?: HookRunner` to the `AgentDependencies` type, after `cwd: string`:

```typescript
type AgentDependencies = {
  db: DB
  llmRegistry: Registry
  toolRegistry: ToolRegistry
  permission: PermissionChecker
  config: Config
  cwd: string
  hookRunner?: HookRunner
}
```

Add `HookRunner` to the `export type { ... }` block.

- [ ] **Step 3: Add type test to `src/core/types.test.ts`**

The existing file uses `expectTypeOf` for type-level assertions. Add a new test inside the existing `describe('core types', ...)` block:

```typescript
it('AgentDependencies has optional hookRunner', () => {
  expectTypeOf<AgentDependencies>().toHaveProperty('hookRunner')
})
```

Also add `HookRunner` to the import from `./types.js`:

```typescript
import type {
  // ... existing imports ...
  HookRunner,
} from './types.js'
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/core/types.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/types.test.ts
git commit -m "feat(core): add optional hookRunner to AgentDependencies"
```

---

## Task 9: Core Integration — Tool Execution (`core/tool-exec.ts`)

**Files:**
- Modify: `src/core/tool-exec.ts`
- Modify: `src/core/tool-exec.test.ts`

Add optional `hookRunner` parameter to `executeToolCall` and `executeToolCalls`. Before executing a tool, run `tool:before` (can modify input or abort → return error result). After execution, fire `tool:after` (fire-and-forget).

- [ ] **Step 1: Read the current `src/core/tool-exec.ts`**

Key functions: `executeToolCall(registry, permission, ctx, name, input)` and `executeToolCalls(registry, permission, ctx, calls)`. The calls flow: partition → parallel (Promise.allSettled) → serial.

- [ ] **Step 2: Modify `src/core/tool-exec.ts`**

Add the import at the top:

```typescript
import type { HookRunner } from '../plugins/types.js'
```

Modify `executeToolCall` to accept and use `hookRunner`:

```typescript
async function executeToolCall(
  registry: ToolRegistry,
  permission: PermissionChecker,
  ctx: ToolContext,
  name: string,
  input: unknown,
  hookRunner?: HookRunner,
): Promise<ToolResult> {
  if (hookRunner) {
    const hookResult = await hookRunner.runHooks('tool:before', { tool: name, input, ctx })
    if (hookResult === false) {
      return { _tag: 'error', error: `Tool "${name}" aborted by hook` }
    }
    input = hookResult.input
  }

  const result = await executeTool(registry, name, input, ctx, permission)

  if (hookRunner) {
    await hookRunner.fireHooks('tool:after', { tool: name, input, result, ctx })
  }

  return result
}
```

Modify `executeToolCalls` to accept and pass `hookRunner`:

```typescript
async function executeToolCalls(
  registry: ToolRegistry,
  permission: PermissionChecker,
  ctx: ToolContext,
  calls: CollectedToolCall[],
  hookRunner?: HookRunner,
): Promise<ToolCallResult[]> {
  const { parallel, serial } = partitionByConflict(calls)
  const results: ToolCallResult[] = []

  if (parallel.length > 0) {
    const settled = await Promise.allSettled(
      parallel.map(async (tc) => ({
        id: tc.id,
        result: await executeToolCall(registry, permission, ctx, tc.tool, tc.input, hookRunner),
      })),
    )
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value)
      } else {
        results.push({ id: 'unknown', result: { _tag: 'error', error: String(s.reason) } })
      }
    }
  }

  for (const tc of serial) {
    const result = await executeToolCall(registry, permission, ctx, tc.tool, tc.input, hookRunner)
    results.push({ id: tc.id, result })
  }

  return results
}
```

Note: `input` in `executeToolCall` must be changed from `const` (param) to a `let` inside the function body to allow hook modification. The simplest way: rename the parameter and use a local `let`:

```typescript
async function executeToolCall(
  registry: ToolRegistry,
  permission: PermissionChecker,
  ctx: ToolContext,
  name: string,
  input: unknown,
  hookRunner?: HookRunner,
): Promise<ToolResult> {
  let effectiveInput = input

  if (hookRunner) {
    const hookResult = await hookRunner.runHooks('tool:before', { tool: name, input, ctx })
    if (hookResult === false) {
      return { _tag: 'error', error: `Tool "${name}" aborted by hook` }
    }
    effectiveInput = hookResult.input
  }

  const result = await executeTool(registry, name, effectiveInput, ctx, permission)

  if (hookRunner) {
    await hookRunner.fireHooks('tool:after', { tool: name, input: effectiveInput, result, ctx })
  }

  return result
}
```

- [ ] **Step 3: Add tests to `src/core/tool-exec.test.ts`**

Append these tests to the existing test file. **Do not create a new file.** Add them inside the existing top-level `describe` block, or as a new `describe` block at the end.

```typescript
describe('executeToolCall with hookRunner', () => {
  it('runs tool:before hook before execution', async () => {
    const hookRunner = createHookRunner()
    const beforeHandler = vi.fn((data) => data)
    hookRunner.on('tool:before', beforeHandler)

    // Use a mock registry that returns success
    const mockRegistry = {
      tools: new Map([
        ['test', {
          name: 'test',
          description: 'test',
          parameters: { type: 'object' },
          permission: 'auto',
          execute: async () => ({ _tag: 'success' as const, output: 'ok' }),
        }],
      ]),
      factories: new Map(),
    }
    const mockPermission = { check: async () => ({ _tag: 'allow' as const }) }
    const ctx = { cwd: '/', session: { id: 's', cwd: '/' }, abort: new AbortController().signal }

    await executeToolCall(mockRegistry as any, mockPermission as any, ctx, 'test', { foo: 1 }, hookRunner)
    expect(beforeHandler).toHaveBeenCalled()
  })

  it('aborts when tool:before returns false', async () => {
    const hookRunner = createHookRunner()
    hookRunner.on('tool:before', () => false)

    const executeFn = vi.fn()
    const mockRegistry = {
      tools: new Map([
        ['blocked', {
          name: 'blocked',
          description: 'test',
          parameters: { type: 'object' },
          permission: 'auto',
          execute: executeFn,
        }],
      ]),
      factories: new Map(),
    }
    const mockPermission = { check: async () => ({ _tag: 'allow' as const }) }
    const ctx = { cwd: '/', session: { id: 's', cwd: '/' }, abort: new AbortController().signal }

    const result = await executeToolCall(mockRegistry as any, mockPermission as any, ctx, 'blocked', {}, hookRunner)
    expect(result._tag).toBe('error')
    expect(executeFn).not.toHaveBeenCalled()
  })

  it('uses modified input from tool:before hook', async () => {
    const hookRunner = createHookRunner()
    hookRunner.on('tool:before', (data) => ({
      ...data,
      input: { ...data.input as object, injected: true },
    }))

    let receivedInput: unknown
    const mockRegistry = {
      tools: new Map([
        ['mod', {
          name: 'mod',
          description: 'test',
          parameters: { type: 'object' },
          permission: 'auto',
          execute: async (input: unknown) => {
            receivedInput = input
            return { _tag: 'success' as const, output: 'ok' }
          },
        }],
      ]),
      factories: new Map(),
    }
    const mockPermission = { check: async () => ({ _tag: 'allow' as const }) }
    const ctx = { cwd: '/', session: { id: 's', cwd: '/' }, abort: new AbortController().signal }

    await executeToolCall(mockRegistry as any, mockPermission as any, ctx, 'mod', { original: true }, hookRunner)
    expect(receivedInput).toEqual({ original: true, injected: true })
  })

  it('fires tool:after after execution', async () => {
    const hookRunner = createHookRunner()
    const afterHandler = vi.fn()
    hookRunner.on('tool:after', afterHandler)

    const mockRegistry = {
      tools: new Map([
        ['after', {
          name: 'after',
          description: 'test',
          parameters: { type: 'object' },
          permission: 'auto',
          execute: async () => ({ _tag: 'success' as const, output: 'done' }),
        }],
      ]),
      factories: new Map(),
    }
    const mockPermission = { check: async () => ({ _tag: 'allow' as const }) }
    const ctx = { cwd: '/', session: { id: 's', cwd: '/' }, abort: new AbortController().signal }

    await executeToolCall(mockRegistry as any, mockPermission as any, ctx, 'after', {}, hookRunner)
    expect(afterHandler).toHaveBeenCalled()
    const callArg = afterHandler.mock.calls[0][0]
    expect(callArg.result._tag).toBe('success')
  })

  it('works without hookRunner (backward compatible)', async () => {
    const mockRegistry = {
      tools: new Map([
        ['plain', {
          name: 'plain',
          description: 'test',
          parameters: { type: 'object' },
          permission: 'auto',
          execute: async () => ({ _tag: 'success' as const, output: 'ok' }),
        }],
      ]),
      factories: new Map(),
    }
    const mockPermission = { check: async () => ({ _tag: 'allow' as const }) }
    const ctx = { cwd: '/', session: { id: 's', cwd: '/' }, abort: new AbortController().signal }

    const result = await executeToolCall(mockRegistry as any, mockPermission as any, ctx, 'plain', {})
    expect(result._tag).toBe('success')
  })
})
```

Make sure the test file imports `createHookRunner` at the top:

```typescript
import { createHookRunner } from '../plugins/hooks.js'
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/core/tool-exec.test.ts`
Expected: All tests PASS (existing + new)

- [ ] **Step 5: Commit**

```bash
git add src/core/tool-exec.ts src/core/tool-exec.test.ts
git commit -m "feat(core): integrate hookRunner into tool execution"
```

---

## Task 10: Core Integration — Agent Loop (`core/loop.ts`)

**Files:**
- Modify: `src/core/loop.ts`
- Modify: `src/core/loop.test.ts`

Inject hooks at four points in the loop:
1. **`message:before`** — after building `chatMessages`, before the LLM request. Chain: can modify or abort.
2. **`provider:before`** — after building `request`, before `streamFn`. Chain: can modify or abort.
3. **`provider:after`** — after the stream completes. Broadcast.
4. **`message:after`** — after persisting the assistant message. Broadcast.

Also pass `deps.hookRunner` to `executeToolCalls`.

- [ ] **Step 1: Read the current `src/core/loop.ts`** to understand the exact structure. Key points:
- `chatMessages` is built from `entriesToChatMessages(entries, snapshots)` + steering messages, all as `const`.
- `request` is built as a `const`.
- The stream is consumed in a `for await` loop.
- After the stream, assistant message is persisted with `appendMessage`.
- Tool calls are executed with `executeToolCalls(...)`.

- [ ] **Step 2: Modify `src/core/loop.ts`**

**Import** (add to existing imports):

```typescript
import type { HookRunner } from '../plugins/types.js'
```

Note: `HookRunner` is already re-exported via `AgentDependencies` which now has `hookRunner?: HookRunner`. But we need the type import for the local variable.

**Inside the `agentLoop` function**, after building `chatMessages` (after steering injection, before building `systemPrompt`):

Change `const chatMessages` to `let chatMessages`. Then add:

```typescript
    if (deps.hookRunner) {
      const hookResult = await deps.hookRunner.runHooks('message:before', { messages: chatMessages })
      if (hookResult === false) {
        yield { _tag: 'error', error: { _tag: 'unexpected', message: 'Aborted by message:before hook' } }
        return
      }
      chatMessages = hookResult.messages
    }
```

After building `request` (the `const request` object), change to `let request` and add:

```typescript
    if (deps.hookRunner) {
      const hookResult = await deps.hookRunner.runHooks('provider:before', { request })
      if (hookResult === false) {
        yield { _tag: 'error', error: { _tag: 'unexpected', message: 'Aborted by provider:before hook' } }
        return
      }
      request = hookResult.request
    }
```

Before the stream loop, add a chunk collector:

```typescript
    const collectedChunks = deps.hookRunner ? [] as StreamChunk[] : undefined
```

Inside the `for await` loop, at the top of the loop body (before the `switch`), add:

```typescript
      if (collectedChunks) collectedChunks.push(chunk)
```

After the stream loop completes (after the `catch` block, before processing `hadError`), add:

```typescript
    if (deps.hookRunner && collectedChunks) {
      await deps.hookRunner.fireHooks('provider:after', { request, chunks: collectedChunks })
    }
```

After persisting the assistant message, capture the return value and fire `message:after`:

Change:
```typescript
    if (assistantContent.length > 0) {
      await appendMessage(deps.db, state.session.id, {
        role: 'assistant',
        content: assistantContent,
      })
    }
```

To:
```typescript
    if (assistantContent.length > 0) {
      const savedMsg = await appendMessage(deps.db, state.session.id, {
        role: 'assistant',
        content: assistantContent,
      })
      if (deps.hookRunner) {
        await deps.hookRunner.fireHooks('message:after', { message: savedMsg })
      }
    }
```

Pass `hookRunner` to `executeToolCalls`:

Change:
```typescript
      const results = await executeToolCalls(
        deps.toolRegistry,
        deps.permission,
        {
          cwd: deps.cwd,
          session: { id: state.session.id, cwd: deps.cwd },
          abort: state.abortController.signal,
        },
        calls,
      )
```

To:
```typescript
      const results = await executeToolCalls(
        deps.toolRegistry,
        deps.permission,
        {
          cwd: deps.cwd,
          session: { id: state.session.id, cwd: deps.cwd },
          abort: state.abortController.signal,
        },
        calls,
        deps.hookRunner,
      )
```

Add `StreamChunk` to the imports from `'../shared/types/llm.js'` (if not already imported):

```typescript
import type { ChatRequest, ChatTool, StreamChunk } from '../shared/types/llm.js'
```

- [ ] **Step 3: Add tests to `src/core/loop.test.ts`**

Read the existing test file to understand the mock setup. Append these tests to the existing file. **Do not create a new file.**

The existing test file already imports `vi` — if not, add it to the vitest import at the top:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest'
```

Add a static import at the top of the file (after existing imports):

```typescript
import { createHookRunner } from '../plugins/hooks.js'
import type { HookRunner } from '../plugins/types.js'
```

Add a helper to create deps with a hookRunner:

```typescript
function makeMockDepsWithHooks(
  db: LoopDeps['db'],
  streamFn: () => AsyncGenerator<StreamChunk>,
  hookRunner: HookRunner,
): LoopDeps {
  return {
    db,
    llmRegistry: {} as LoopDeps['llmRegistry'],
    toolRegistry: createDefaultRegistry(),
    permission: autoAllowChecker,
    config: DEFAULT_CONFIG,
    cwd: process.cwd(),
    chatStream: streamFn as unknown as LoopDeps['chatStream'],
    hookRunner,
  }
}
```

Then append the describe block:

```typescript
describe('agentLoop with hookRunner', () => {
  it('fires provider:before hook before LLM call', async () => {
    const hookRunner = createHookRunner()
    const beforeHandler = vi.fn((data) => data)
    hookRunner.on('provider:before', beforeHandler)

    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDepsWithHooks(db, () => mockTextStream('hello'), hookRunner)
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(beforeHandler).toHaveBeenCalledOnce()
    const callArg = beforeHandler.mock.calls[0][0]
    expect(callArg.request.model).toBe('mock')
  })

  it('aborts when provider:before returns false', async () => {
    const hookRunner = createHookRunner()
    hookRunner.on('provider:before', () => false)

    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDepsWithHooks(db, () => mockTextStream('should-not-appear'), hookRunner)
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'error')).toBe(true)
    expect(events.some((e) => e._tag === 'text_delta')).toBe(false)
  })

  it('fires message:before hook with messages array', async () => {
    const hookRunner = createHookRunner()
    const beforeHandler = vi.fn((data) => data)
    hookRunner.on('message:before', beforeHandler)

    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDepsWithHooks(db, () => mockTextStream('ok'), hookRunner)
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    expect(beforeHandler).toHaveBeenCalledOnce()
    const callArg = beforeHandler.mock.calls[0][0]
    expect(Array.isArray(callArg.messages)).toBe(true)
    expect(callArg.messages.length).toBeGreaterThan(0)
  })

  it('fires provider:after hook after stream completes', async () => {
    const hookRunner = createHookRunner()
    const afterHandler = vi.fn()
    hookRunner.on('provider:after', afterHandler)

    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDepsWithHooks(db, () => mockTextStream('response'), hookRunner)
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    expect(afterHandler).toHaveBeenCalledOnce()
    const callArg = afterHandler.mock.calls[0][0]
    expect(callArg.chunks.length).toBeGreaterThan(0)
    expect(callArg.chunks.some((c: StreamChunk) => c._tag === 'text')).toBe(true)
  })

  it('passes hookRunner to executeToolCalls (tool:before fires)', async () => {
    const hookRunner = createHookRunner()
    const toolBeforeHandler = vi.fn((data) => data)
    hookRunner.on('tool:before', toolBeforeHandler)

    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDepsWithHooks(db, () => mockToolThenTextStream(), hookRunner)
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    // mockToolThenTextStream yields a read tool call on turn 0
    expect(toolBeforeHandler).toHaveBeenCalledOnce()
    const callArg = toolBeforeHandler.mock.calls[0][0]
    expect(callArg.tool).toBe('read')
  })
})
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/core/loop.test.ts`
Expected: All tests PASS (existing + new)

- [ ] **Step 5: Commit**

```bash
git add src/core/loop.ts src/core/loop.test.ts
git commit -m "feat(core): integrate hooks into agent loop"
```

---

## Task 11: Full Suite Verification & Lint

**Files:**
- No new files

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: All tests PASS. Previous count was 452 tests / 61 files. New count should be ~540+ tests / 70+ files.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Run lint**

Run: `pnpm biome check src/`
Expected: No errors (run `pnpm biome check --write src/` to auto-fix if needed)

- [ ] **Step 4: Verify no circular imports**

Check that the dependency graph is acyclic:
- `plugins → shared` ✓
- `plugins → tools` (lifecycle.ts only) ✓
- `plugins → llm` (lifecycle.ts only) ✓
- `plugins → core` (config import in tests only — not in source) ✓
- `core → plugins` (HookRunner type in types.ts) ✓
- No path: `plugins → core → plugins`

- [ ] **Step 5: Commit any lint fixes**

```bash
git add -A
git commit -m "chore: lint fixes for plugins package"
```

---

## Summary

| Task | File(s) | Tests | Commit |
|------|---------|-------|--------|
| 1 | types.ts, logger.ts | 6 | feat(plugins): add plugin types and logger |
| 2 | hooks.ts | 15 | feat(plugins): add hook runner with chain/broadcast/timeout |
| 3 | registry.ts | 8 | feat(plugins): add plugin registry |
| 4 | lifecycle.ts | 12 | feat(plugins): add plugin lifecycle (activate/deactivate) |
| 5 | loader.ts | 11 | feat(plugins): add plugin loader and discovery |
| 6 | builtin.ts | 9 | feat(plugins): add builtin hooks (audit-log, write-guard) |
| 7 | index.ts | 6 | feat(plugins): add barrel export |
| 8 | core/types.ts | +1 | feat(core): add optional hookRunner to AgentDependencies |
| 9 | core/tool-exec.ts | +5 | feat(core): integrate hookRunner into tool execution |
| 10 | core/loop.ts | +5 | feat(core): integrate hooks into agent loop |
| 11 | — | — | Full suite verification |

**Estimated new test count: ~78** (6+15+8+12+11+9+6+1+5+5)
