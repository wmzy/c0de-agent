// src/plugins/registry.test.ts
import { describe, expect, it } from 'vitest'
import { createHookRunner } from './hooks.js'
import { createPluginRegistry, registerPlugin } from './registry.js'
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

  it('registerPlugin replaces existing plugin with same name', () => {
    const registry = createPluginRegistry(createHookRunner())
    registerPlugin(registry, makePlugin('dup'))
    registerPlugin(registry, makePlugin('dup'))
    expect(registry.plugins.size).toBe(1)
  })
})
