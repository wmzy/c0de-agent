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
