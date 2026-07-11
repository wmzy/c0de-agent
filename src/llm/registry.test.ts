import { describe, expect, it } from 'vitest'
import type { ModelRole } from '../shared/types/llm.js'
import {
  createRegistry,
  DEFAULT_MODEL_CAPABILITIES,
  overrideToCapabilities,
  registerProvider,
  resolveModelByRole,
  resolveRoute,
  setRole,
} from './registry.js'
import { isLLMError } from './schema/errors.js'

const defaultRole: ModelRole = { _tag: 'default' }

describe('registry register + resolveRoute', () => {
  it('resolves a registered provider and model with capabilities', () => {
    const reg = createRegistry()
    registerProvider(reg, {
      name: 'openai',
      baseURL: 'https://api.openai.com',
      apiKey: 'sk-x',
      models: {
        'gpt-4o': {
          contextWindow: 128000,
          maxOutput: 16384,
          supportsTools: true,
          supportsVision: true,
          supportsThinking: false,
          costPer1kInput: 0,
          costPer1kOutput: 0,
        },
      },
    })
    const res = resolveRoute(reg, 'openai', 'gpt-4o')
    expect(res.model.id).toBe('gpt-4o')
    expect(res.capabilities.contextWindow).toBe(128000)
    expect(res.route.path).toBe('/v1/chat/completions')
  })

  it('uses default capabilities for unknown models', () => {
    const reg = createRegistry()
    registerProvider(reg, { name: 'groq', baseURL: 'https://x', apiKey: 'k' })
    const res = resolveRoute(reg, 'groq', 'llama-3-70b')
    expect(res.capabilities.contextWindow).toBe(128_000)
  })

  it('passes declared per-model capabilities through registerProvider', () => {
    const reg = createRegistry()
    registerProvider(reg, {
      name: 'sensenova',
      baseURL: 'https://x',
      apiKey: 'k',
      models: overrideToCapabilities({
        'sensenova-6.7-flash-lite': { contextWindow: 1_000_000, maxOutput: 8192 },
      }),
    })
    const res = resolveRoute(reg, 'sensenova', 'sensenova-6.7-flash-lite')
    expect(res.capabilities.contextWindow).toBe(1_000_000)
  })
})

describe('overrideToCapabilities', () => {
  it('fills missing fields with DEFAULT_MODEL_CAPABILITIES', () => {
    const caps = overrideToCapabilities({ 'm1': { contextWindow: 200_000 } })
    expect(caps['m1']?.contextWindow).toBe(200_000)
    expect(caps['m1']?.maxOutput).toBe(DEFAULT_MODEL_CAPABILITIES.maxOutput)
    expect(caps['m1']?.supportsTools).toBe(true)
  })

  it('strips enabled flag (UI-only concern)', () => {
    const caps = overrideToCapabilities({ 'm1': { enabled: false, contextWindow: 100_000 } })
    expect(caps['m1']).toBeDefined()
    expect('enabled' in (caps['m1'] as Record<string, unknown>)).toBe(false)
  })

  it('returns empty object for empty input', () => {
    expect(overrideToCapabilities({})).toEqual({})
  })
})

describe('registry resolveRoute edge cases', () => {
  it('throws NoRoute for unknown provider', () => {
    const reg = createRegistry()
    try {
      resolveRoute(reg, 'ghost', 'm1')
      throw new Error('should not reach')
    } catch (e) {
      expect(isLLMError(e)).toBe(true)
    }
  })
})

describe('registry roles', () => {
  it('resolves a role to its configured provider/model', () => {
    const reg = createRegistry()
    registerProvider(reg, { name: 'openai', baseURL: 'https://x', apiKey: 'k' })
    setRole(reg, defaultRole, 'openai', 'gpt-4o')
    expect(resolveModelByRole(reg, defaultRole)).toEqual({ provider: 'openai', model: 'gpt-4o' })
  })

  it('falls back to default role when a specific role is unset', () => {
    const reg = createRegistry()
    registerProvider(reg, { name: 'deepseek', baseURL: 'https://x', apiKey: 'k' })
    setRole(reg, defaultRole, 'deepseek', 'deepseek-chat')
    const smolRole: ModelRole = { _tag: 'smol' }
    expect(resolveModelByRole(reg, smolRole)).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
  })

  it('throws NoRoute when no roles are configured', () => {
    const reg = createRegistry()
    try {
      resolveModelByRole(reg, defaultRole)
      throw new Error('should not reach')
    } catch (e) {
      expect(isLLMError(e)).toBe(true)
    }
  })
})
