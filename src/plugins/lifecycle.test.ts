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
    const { services } = makeServices()
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
