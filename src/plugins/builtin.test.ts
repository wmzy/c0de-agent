// src/plugins/builtin.test.ts

import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../core/config.js'
import { createRegistry as createLLMRegistry } from '../llm/registry.js'
import { createToolRegistry } from '../tools/registry.js'
import {
  BUILTIN_PLUGINS,
  createToolAuditLogger,
  createWriteGuard,
  registerBuiltinHooks,
} from './builtin.js'
import { createHookRunner } from './hooks.js'
import { activatePlugin, deactivateAll } from './lifecycle.js'
import { createPluginRegistry, registerPlugin } from './registry.js'
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
      ctx: {
        cwd: process.cwd(),
        session: { id: 's1', cwd: process.cwd() },
        abort: new AbortController().signal,
      },
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
      ctx: {
        cwd: process.cwd(),
        session: { id: 's1', cwd: process.cwd() },
        abort: new AbortController().signal,
      },
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
