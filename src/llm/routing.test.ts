import { describe, expect, it } from 'vitest'
import { createRegistry, registerProvider } from './registry.js'
import { runWithFallback, shouldFallOver } from './routing.js'
import { isLLMError, llmError } from './schema/errors.js'

const noSleep = async () => {}

const setup = () => {
  const reg = createRegistry()
  registerProvider(reg, { name: 'a', baseURL: 'https://a', apiKey: 'k' })
  registerProvider(reg, { name: 'b', baseURL: 'https://b', apiKey: 'k' })
  return reg
}

const internalError = () =>
  llmError('LLM', 'stream', { _tag: 'ProviderInternal', message: '500', status: 500 })
const authError = () =>
  llmError('LLM', 'stream', { _tag: 'Authentication', message: 'bad', kind: 'invalid' })
const overflowError = () =>
  llmError('LLM', 'stream', {
    _tag: 'InvalidRequest',
    message: 'x',
    classification: 'context-overflow',
  })

describe('routing shouldFallOver', () => {
  it('falls over on ProviderInternal', () => {
    expect(shouldFallOver(internalError())).toBe(true)
  })
  it('falls over on Authentication (spec §7.6: invalid key should try next route)', () => {
    expect(shouldFallOver(authError())).toBe(true)
  })
  it('does not fall over on context overflow', () => {
    expect(shouldFallOver(overflowError())).toBe(false)
  })
  it('does not fall over on non-LLMError', () => {
    expect(shouldFallOver(new Error('x'))).toBe(false)
  })
})

describe('routing runWithFallback', () => {
  it('succeeds on the primary route', async () => {
    const res = await runWithFallback(
      setup(),
      {
        primary: { provider: 'a', model: 'm1' },
        fallbacks: [],
        maxRetries: 0,
        retryDelay: 0,
        sleep: noSleep,
      },
      async () => 'ok',
    )
    expect(res.result).toBe('ok')
    expect(res.provider).toBe('a')
  })

  it('falls over to the next route after a ProviderInternal', async () => {
    const calls: string[] = []
    const res = await runWithFallback(
      setup(),
      {
        primary: { provider: 'a', model: 'm1' },
        fallbacks: [{ provider: 'b', model: 'm2' }],
        maxRetries: 0,
        retryDelay: 0,
        sleep: noSleep,
      },
      async (provider) => {
        calls.push(provider)
        if (provider === 'a') throw internalError()
        return 'ok'
      },
    )
    expect(calls).toEqual(['a', 'b'])
    expect(res.provider).toBe('b')
  })

  it('falls over on auth errors and tries the next route', async () => {
    const calls: string[] = []
    await expect(
      runWithFallback(
        setup(),
        {
          primary: { provider: 'a', model: 'm1' },
          fallbacks: [{ provider: 'b', model: 'm2' }],
          maxRetries: 0,
          retryDelay: 0,
          sleep: noSleep,
        },
        async (provider) => {
          calls.push(provider)
          throw authError()
        },
      ),
    ).rejects.toSatisfy((e: unknown) => isLLMError(e) && e.reason._tag === 'Authentication')
    expect(calls).toEqual(['a', 'b'])
  })

  it('retries retryable errors within a route before falling over', async () => {
    let primaryCalls = 0
    const res = await runWithFallback(
      setup(),
      {
        primary: { provider: 'a', model: 'm1' },
        fallbacks: [],
        maxRetries: 2,
        retryDelay: 0,
        sleep: noSleep,
      },
      async () => {
        primaryCalls += 1
        if (primaryCalls < 3) throw internalError()
        return 'recovered'
      },
    )
    expect(res.result).toBe('recovered')
    expect(primaryCalls).toBe(3)
  })

  it('throws the last error when all routes fail', async () => {
    await expect(
      runWithFallback(
        setup(),
        {
          primary: { provider: 'a', model: 'm1' },
          fallbacks: [{ provider: 'b', model: 'm2' }],
          maxRetries: 0,
          retryDelay: 0,
          sleep: noSleep,
        },
        async () => {
          throw internalError()
        },
      ),
    ).rejects.toSatisfy((e: unknown) => isLLMError(e))
  })
})
