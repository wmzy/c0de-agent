import { describe, expect, it } from 'vitest'
import {
  isLLMError,
  llmError,
  reasonMessage,
  reasonRetryAfterMs,
  reasonRetryable,
  toolFailure,
} from './errors.js'

describe('schema/errors llmError', () => {
  it('builds a NoRoute error with auto message', () => {
    const err = llmError('LLM', 'resolve', {
      _tag: 'NoRoute',
      route: 'openai-chat',
      provider: 'openai',
      model: 'gpt-x',
    })
    expect(err.message).toBe(
      'LLM.resolve: No LLM route for model "gpt-x" using provider "openai" (route "openai-chat")',
    )
    expect(isLLMError(err)).toBe(true)
  })

  it('builds a RateLimit error', () => {
    const err = llmError('LLM', 'stream', {
      _tag: 'RateLimit',
      message: 'slow down',
      retryAfterMs: 2000,
    })
    expect(err.reason._tag).toBe('RateLimit')
  })

  it('isLLMError rejects plain errors', () => {
    expect(isLLMError(new Error('boom'))).toBe(false)
    expect(isLLMError(null)).toBe(false)
  })
})

describe('schema/errors retryable', () => {
  it('RateLimit and ProviderInternal are retryable', () => {
    expect(reasonRetryable({ _tag: 'RateLimit', message: 'x', retryAfterMs: 100 })).toBe(true)
    expect(reasonRetryable({ _tag: 'ProviderInternal', message: 'x', status: 503 })).toBe(true)
  })

  it('InvalidRequest is not retryable', () => {
    expect(reasonRetryable({ _tag: 'InvalidRequest', message: 'x' })).toBe(false)
  })

  it('context-overflow InvalidRequest is not retryable', () => {
    expect(
      reasonRetryable({ _tag: 'InvalidRequest', message: 'x', classification: 'context-overflow' }),
    ).toBe(false)
  })

  it('extracts retryAfterMs only from RateLimit/ProviderInternal', () => {
    expect(reasonRetryAfterMs({ _tag: 'RateLimit', message: 'x', retryAfterMs: 500 })).toBe(500)
    expect(reasonRetryAfterMs({ _tag: 'InvalidRequest', message: 'x' })).toBeUndefined()
  })
})

describe('schema/errors ToolFailure', () => {
  it('builds a ToolFailure', () => {
    const f = toolFailure('bad input', { code: 1 })
    expect(f.message).toBe('bad input')
    expect(f.metadata).toEqual({ code: 1 })
  })
})

describe('schema/errors reasonMessage', () => {
  it('returns the stored message for non-NoRoute reasons', () => {
    expect(reasonMessage({ _tag: 'Transport', message: 'tcp reset' })).toBe('tcp reset')
  })
})
