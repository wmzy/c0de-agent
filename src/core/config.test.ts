import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, loadConfig, mergeConfig, saveConfig } from './config.js'

const tmp = join(tmpdir(), `c0de-config-test-${Date.now()}`)

beforeEach(() => mkdirSync(tmp, { recursive: true }))
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('DEFAULT_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_CONFIG.providers).toEqual([])
    expect(DEFAULT_CONFIG.compaction.enabled).toBe(true)
    expect(DEFAULT_CONFIG.compaction.threshold).toBe(0.8)
    expect(DEFAULT_CONFIG.tools.enabled).toContain('read')
    expect(DEFAULT_CONFIG.fallback.maxRetries).toBe(3)
  })
})

describe('mergeConfig', () => {
  it('returns DEFAULT when no overrides', () => {
    const merged = mergeConfig()
    expect(merged.defaultModel).toBe(DEFAULT_CONFIG.defaultModel)
  })

  it('overrides top-level keys', () => {
    const merged = mergeConfig({ defaultModel: 'gpt-5' })
    expect(merged.defaultModel).toBe('gpt-5')
  })

  it('deep-merges nested objects', () => {
    const merged = mergeConfig({
      compaction: { threshold: 0.9, enabled: true, reserveTokens: 8000, keepRecentTokens: 4000 },
    })
    expect(merged.compaction.threshold).toBe(0.9)
    expect(merged.compaction.enabled).toBe(true)
  })

  it('later overrides win', () => {
    const merged = mergeConfig({ defaultModel: 'a' }, { defaultModel: 'b' })
    expect(merged.defaultModel).toBe('b')
  })

  it('replaces arrays, not concatenates', () => {
    const merged = mergeConfig({ providers: [{ name: 'x', protocol: 'openai', apiKey: 'k' }] })
    expect(merged.providers).toHaveLength(1)
  })
})

describe('saveConfig / loadConfig', () => {
  it('saves and loads project config', async () => {
    await saveConfig(mergeConfig({ defaultModel: 'claude' }), 'project', tmp)
    const loaded = await loadConfig(tmp)
    expect(loaded.defaultModel).toBe('claude')
  })

  it('returns defaults when no config files exist', async () => {
    const loaded = await loadConfig(tmp)
    // Config is valid regardless of global state
    expect(loaded).toHaveProperty('defaultModel')
    expect(loaded).toHaveProperty('compaction')
    expect(loaded.compaction).toHaveProperty('threshold')
  })

  it('project config overrides defaults', async () => {
    await saveConfig(mergeConfig({ defaultModel: 'project-model' }), 'project', tmp)
    const loaded = await loadConfig(tmp)
    expect(loaded.defaultModel).toBe('project-model')
  })
})
