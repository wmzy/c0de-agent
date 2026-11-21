import { describe, expect, it } from 'vitest'
import { costUsdForCall, type ModelCatalog, resolveModelCatalogEntry } from './model-catalog.js'

/** Minimal injected catalog: resolver tests must not depend on the bundled
 *  generated data (which legitimately changes on every regeneration). */
const testCatalog: ModelCatalog = {
  openai: {
    models: {
      'gpt-4o': { contextWindow: 128000, inputPricePerMTok: 2.5, outputPricePerMTok: 10 },
      'gpt-4o-2024-11-20': {
        contextWindow: 128000,
        inputPricePerMTok: 2.5,
        outputPricePerMTok: 10,
      },
    },
  },
  anthropic: {
    models: {
      'claude-sonnet-4-5': { contextWindow: 200000, inputPricePerMTok: 3, outputPricePerMTok: 15 },
    },
  },
  openrouter: {
    models: {
      'anthropic/claude-sonnet-4-5': { inputPricePerMTok: 3, outputPricePerMTok: 15 },
    },
  },
  'amazon-bedrock': {
    models: {
      'anthropic.claude-sonnet-4-5-20250929-v2:0': {
        contextWindow: 200000,
        inputPricePerMTok: 3,
        outputPricePerMTok: 15,
      },
    },
  },
  'free-provider': {
    models: {
      'free-model': { contextWindow: 32000, inputPricePerMTok: 0, outputPricePerMTok: 0 },
    },
  },
}

const resolve = (providerId: string | undefined, modelId: string, baseURL?: string) =>
  resolveModelCatalogEntry({ providerId, baseURL }, modelId, testCatalog)

describe('resolveModelCatalogEntry provider matching', () => {
  it('resolves via explicit provider id', () => {
    expect(resolve('openai', 'gpt-4o')).toEqual({
      contextWindow: 128000,
      inputPricePerMTok: 2.5,
      outputPricePerMTok: 10,
    })
  })

  it('normalizes provider id case and surrounding whitespace', () => {
    expect(resolve('  OpenAI ', 'gpt-4o')).toEqual(resolve('openai', 'gpt-4o'))
  })

  it('resolves via baseURL host alias (host only, path ignored)', () => {
    const viaHost = resolve(undefined, 'gpt-4o', 'https://api.openai.com/v1')
    expect(viaHost).toEqual(resolve('openai', 'gpt-4o'))
  })

  it('prefers the explicit provider id over the baseURL host', () => {
    // Provider explicitly named anthropic on an OpenAI host: the id resolves to
    // the anthropic bucket and the host alias is never consulted — so an
    // openai-only model misses instead of being priced with OpenAI rates.
    expect(resolve('anthropic', 'gpt-4o', 'https://api.openai.com/v1')).toBeNull()
  })

  it('resolves regional cloud endpoints via host suffix rules', () => {
    const bedrock = resolve(
      undefined,
      'anthropic.claude-sonnet-4-5-20250929-v2:0',
      'https://bedrock-runtime.us-west-2.amazonaws.com',
    )
    expect(bedrock).not.toBeNull()
  })

  it('returns null for unknown hosts, invalid baseURLs and unknown providers', () => {
    expect(resolve(undefined, 'gpt-4o', 'https://gateway.example.com/v1')).toBeNull()
    expect(resolve(undefined, 'gpt-4o', 'not a url')).toBeNull()
    expect(resolve('unknown-provider', 'gpt-4o')).toBeNull()
  })

  it('falls back to the host alias when the provider id misses', () => {
    expect(resolve('typo-provider', 'gpt-4o', 'https://api.openai.com/v1')).toEqual(
      resolve('openai', 'gpt-4o'),
    )
  })
})

describe('resolveModelCatalogEntry model matching', () => {
  it('matches exact ids', () => {
    expect(resolve('anthropic', 'claude-sonnet-4-5')?.inputPricePerMTok).toBe(3)
  })

  it('matches case-insensitively', () => {
    expect(resolve('openai', 'GPT-4O')?.outputPricePerMTok).toBe(10)
  })

  it('strips vendor prefixes (openrouter-style ids)', () => {
    // openrouter bucket keys keep the `vendor/` prefix — exact hit
    expect(resolve('openrouter', 'anthropic/claude-sonnet-4-5')?.inputPricePerMTok).toBe(3)
    // the same id sent to a vendor-direct provider — prefix stripped
    expect(resolve('anthropic', 'anthropic/claude-sonnet-4-5')?.inputPricePerMTok).toBe(3)
  })

  it('strips trailing date suffixes (YYYYMMDD and YYYY-MM-DD)', () => {
    expect(resolve('anthropic', 'claude-sonnet-4-5-20250929')?.inputPricePerMTok).toBe(3)
    expect(resolve('openai', 'gpt-4o-2024-11-20')?.inputPricePerMTok).toBe(2.5)
  })

  it('returns null when nothing matches — never guesses a price', () => {
    expect(resolve('openai', 'totally-unknown-model')).toBeNull()
    expect(resolve('anthropic', 'claude-sonnet-4-5/v2')).toBeNull()
  })
})

describe('costUsdForCall precedence', () => {
  it('user-configured prices win over the catalog', () => {
    const cost = costUsdForCall(
      { providerId: 'openai' },
      'gpt-4o',
      { costPer1kInput: 0.002, costPer1kOutput: 0.008 },
      { inputTokens: 1000, outputTokens: 1000 },
      testCatalog,
    )
    // configured: 0.002 + 0.008 = 0.01 — not the catalog's 2.5/10 per 1M
    expect(cost).toBeCloseTo(0.01, 10)
  })

  it('falls back to catalog prices ($/1M) when configured prices are unset', () => {
    const cost = costUsdForCall(
      { providerId: 'openai' },
      'gpt-4o',
      { costPer1kInput: 0, costPer1kOutput: 0 },
      { inputTokens: 1_000_000, outputTokens: 500_000 },
      testCatalog,
    )
    expect(cost).toBeCloseTo(2.5 + 5, 10)
  })

  it('returns null when neither source knows a price', () => {
    expect(
      costUsdForCall(
        { providerId: 'openai' },
        'unknown-model',
        { costPer1kInput: 0, costPer1kOutput: 0 },
        { inputTokens: 1000, outputTokens: 1000 },
        testCatalog,
      ),
    ).toBeNull()
  })

  it('treats an explicit 0/0 catalog entry as known-free ($0, not unknown)', () => {
    const cost = costUsdForCall(
      { providerId: 'free-provider' },
      'free-model',
      { costPer1kInput: 0, costPer1kOutput: 0 },
      { inputTokens: 12345, outputTokens: 6789 },
      testCatalog,
    )
    expect(cost).toBe(0)
  })

  it('returns null for context-only entries (no price data)', () => {
    const contextOnly: ModelCatalog = {
      openai: { models: { 'gpt-x': { contextWindow: 128000 } } },
    }
    expect(
      costUsdForCall(
        { providerId: 'openai' },
        'gpt-x',
        { costPer1kInput: 0, costPer1kOutput: 0 },
        { inputTokens: 1000, outputTokens: 1000 },
        contextOnly,
      ),
    ).toBeNull()
  })
})
