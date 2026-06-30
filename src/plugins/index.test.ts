// src/plugins/index.test.ts
import { describe, expect, it } from 'vitest'
import { createRegistry } from '../llm/registry.js'
import type { Config } from '../shared/types/config.js'
import { createToolRegistry } from '../tools/registry.js'
import * as plugins from './index.js'
import { initPlugins } from './init.js'

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

describe('initPlugins', () => {
  it('activates builtin plugins and returns a wired hookRunner', async () => {
    const { pluginRegistry, hookRunner } = await initPlugins({
      cwd: '/nonexistent-c0de-plugins-dir', // 无外部插件目录 → 仅 builtin
      config: {} as Config,
      toolRegistry: createToolRegistry(),
      llmRegistry: createRegistry(),
    })

    expect(hookRunner).toBeTruthy()
    expect(typeof hookRunner.on).toBe('function')

    const records = plugins.listPlugins(pluginRegistry)
    expect(records.some((r) => r.plugin.name === 'tool-audit-log' && r.status === 'active')).toBe(
      true,
    )
    expect(records.some((r) => r.plugin.name === 'write-guard' && r.status === 'active')).toBe(true)
  })
})
