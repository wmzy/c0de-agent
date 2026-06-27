// src/plugins/loader.test.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverPlugins, loadPlugin, validatePluginModule } from './loader.js'
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
    if (result.valid) {
      expect(result.plugin.name).toBe('test')
    }
  })

  it('accepts a module without default export (named export)', () => {
    const plugin: Plugin = { name: 'named', version: '1.0.0', setup: () => {} }
    const result = validatePluginModule(plugin)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.plugin.name).toBe('named')
    }
  })

  it('rejects a module missing name', () => {
    const result = validatePluginModule({
      default: { version: '1.0.0', setup: () => {} },
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain('name')
    }
  })

  it('rejects a module missing version', () => {
    const result = validatePluginModule({
      default: { name: 'test', setup: () => {} },
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain('version')
    }
  })

  it('rejects a module missing setup', () => {
    const result = validatePluginModule({
      default: { name: 'test', version: '1.0.0' },
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain('setup')
    }
  })

  it('rejects a module where setup is not a function', () => {
    const result = validatePluginModule({
      default: { name: 'test', version: '1.0.0', setup: 'not-a-fn' },
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain('setup')
    }
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
