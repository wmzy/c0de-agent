import { describe, expect, it } from 'vitest'
import type { ModelRole } from '../shared/types/llm.js'
import type { Registry } from './registry.js'
import {
  createRegistry,
  DEFAULT_MODEL_CAPABILITIES,
  overrideToCapabilities,
  rebuildRegistry,
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
    const caps = overrideToCapabilities({ m1: { contextWindow: 200_000 } })
    expect(caps.m1?.contextWindow).toBe(200_000)
    expect(caps.m1?.maxOutput).toBe(DEFAULT_MODEL_CAPABILITIES.maxOutput)
    expect(caps.m1?.supportsTools).toBe(true)
  })

  it('strips enabled flag (UI-only concern)', () => {
    const caps = overrideToCapabilities({ m1: { enabled: false, contextWindow: 100_000 } })
    expect(caps.m1).toBeDefined()
    expect('enabled' in (caps.m1 as Record<string, unknown>)).toBe(false)
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

describe('registry atomic rebuild (concurrency safety)', () => {
  /** resolveRoute succeeds (no NoRoute) for (provider, model). */
  const resolves = (reg: Registry, provider: string, model: string): boolean => {
    try {
      resolveRoute(reg, provider, model)
      return true
    } catch {
      return false
    }
  }

  /** resolveModelByRole succeeds (no NoRoute) for a role. */
  const roleResolves = (reg: Registry, role: ModelRole): boolean => {
    try {
      resolveModelByRole(reg, role)
      return true
    } catch {
      return false
    }
  }

  it('mid-rebuild readers observe a consistent table — never a half-cleared state', () => {
    // Reproduces the syncRegistryFromConfig hazard: a config reload rebuilds
    // the shared registry while a concurrent request fires resolveRoute.
    const reg = createRegistry()
    registerProvider(reg, { name: 'old-a', baseURL: 'https://x', apiKey: 'k' })
    registerProvider(reg, { name: 'old-b', baseURL: 'https://x', apiKey: 'k' })
    setRole(reg, defaultRole, 'old-a', 'm1')

    // Snapshot taken *during* the rebuild, after the builder has registered a
    // new provider into the detached next registry but before the swap.
    // Models a concurrent resolveRoute / resolveModelByRole hitting the LIVE
    // registry mid-reload. Sentinel values are chosen to FAIL the assertions
    // below if the builder never runs.
    const midBuild = {
      oldA: false,
      oldB: false,
      newA: true,
      defaultRole: false,
    }
    rebuildRegistry(reg, (next) => {
      registerProvider(next, { name: 'new-a', baseURL: 'https://y', apiKey: 'k' })
      // Concurrent reader observes the LIVE registry right now.
      midBuild.oldA = resolves(reg, 'old-a', 'm1')
      midBuild.oldB = resolves(reg, 'old-b', 'm1')
      midBuild.newA = resolves(reg, 'new-a', 'm1')
      midBuild.defaultRole = roleResolves(reg, defaultRole)
      registerProvider(next, { name: 'new-b', baseURL: 'https://y', apiKey: 'k' })
    })

    // During rebuild: the previous table is fully intact and the new providers
    // are not yet visible. (With the old clear()-then-register approach every
    // one of these would be false — the half-state this fix eliminates.)
    expect(midBuild.oldA).toBe(true)
    expect(midBuild.oldB).toBe(true)
    expect(midBuild.newA).toBe(false)
    expect(midBuild.defaultRole).toBe(true)

    // After rebuild: new providers live, old providers gone.
    expect(resolves(reg, 'new-a', 'm1')).toBe(true)
    expect(resolves(reg, 'new-b', 'm1')).toBe(true)
    expect(resolves(reg, 'old-a', 'm1')).toBe(false)
    expect(resolves(reg, 'old-b', 'm1')).toBe(false)
  })

  it('rebuild swaps routes + roles together — no window with mixed old/new maps', () => {
    // After rebuild returns, routes AND roles both reflect the new table;
    // there is no observable moment where routes=new but roles=old.
    const reg = createRegistry()
    registerProvider(reg, { name: 'p1', baseURL: 'https://x', apiKey: 'k' })
    setRole(reg, defaultRole, 'p1', 'm1')

    rebuildRegistry(reg, (next) => {
      registerProvider(next, { name: 'p2', baseURL: 'https://x', apiKey: 'k' })
      setRole(next, defaultRole, 'p2', 'm2')
    })

    // New route resolves with declared capabilities; old route is gone.
    const res = resolveRoute(reg, 'p2', 'm2')
    expect(res.route).toBeDefined()
    expect(resolves(reg, 'p1', 'm1')).toBe(false)
    // Role now points at the new (provider, model).
    expect(resolveModelByRole(reg, defaultRole)).toEqual({ provider: 'p2', model: 'm2' })
  })

  it('rebuild to an empty provider set yields a clean empty table', () => {
    const reg = createRegistry()
    registerProvider(reg, { name: 'gone', baseURL: 'https://x', apiKey: 'k' })

    rebuildRegistry(reg, () => {
      // no providers registered
    })

    expect(resolves(reg, 'gone', 'm1')).toBe(false)
    // A second rebuild can repopulate from the emptied state.
    rebuildRegistry(reg, (next) => {
      registerProvider(next, { name: 'back', baseURL: 'https://x', apiKey: 'k' })
    })
    expect(resolves(reg, 'back', 'm1')).toBe(true)
  })
})
