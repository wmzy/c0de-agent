import { describe, expect, it } from 'vitest'
import { isContextOverflow, isContextOverflowFailure } from './provider-error.js'
import { llmError } from './schema/errors.js'

describe('provider-error isContextOverflow', () => {
  it.each([
    "This model's maximum context length is 8192 tokens",
    'prompt is too long',
    'The request exceeds the context window',
    'Please reduce the length of the messages',
    'context_length_exceeded',
    'model_context_window_exceeded',
    '400 (no body)',
    '413 status code (no body)',
  ])('matches overflow phrase: %s', (msg) => {
    expect(isContextOverflow(msg)).toBe(true)
  })

  it.each([
    'everything is fine',
    'rate limit exceeded',
    'unauthorized',
  ])('does not match non-overflow phrase: %s', (msg) => {
    expect(isContextOverflow(msg)).toBe(false)
  })
})

describe('provider-error isContextOverflowFailure', () => {
  it('detects a context-overflow LLMError', () => {
    const err = llmError('LLM', 'stream', {
      _tag: 'InvalidRequest',
      message: 'too long',
      classification: 'context-overflow',
    })
    expect(isContextOverflowFailure(err)).toBe(true)
  })

  it('rejects a non-overflow LLMError', () => {
    const err = llmError('LLM', 'stream', { _tag: 'RateLimit', message: 'slow' })
    expect(isContextOverflowFailure(err)).toBe(false)
  })

  it('rejects non-LLMError values', () => {
    expect(isContextOverflowFailure(new Error('x'))).toBe(false)
    expect(isContextOverflowFailure({ foo: 1 })).toBe(false)
  })
})
