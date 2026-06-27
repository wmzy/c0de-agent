// src/plugins/registry.test.ts
import { describe, expect, it } from 'vitest'
import { createHookRunner } from './hooks.js'
import {
  createPluginRegistry,
  getPlugin,
  listPlugins,
  registerPlugin,
  unregisterPlugin,
} from './registry.js'
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
