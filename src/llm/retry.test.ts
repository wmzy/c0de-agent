import { describe, expect, it } from 'vitest'
import { delay, retryable, withRetry } from './retry.js'
import { isLLMError, llmError } from './schema/errors.js'

const rateLimitError = (headers?: Record<string, string>) =>
  llmError('LLM', 'stream', {
    _tag: 'RateLimit',
    message: 'slow down',
    retryAfterMs: 100,
    http: headers
      ? {
          request: { method: 'POST', url: 'x', headers: {} },
          response: { status: 429, headers },
        }
      : undefined,
  })

const overflowError = () =>
  llmError('LLM', 'stream', {
    _tag: 'InvalidRequest',
    message: 'too long',
    classification: 'context-overflow',
  })

const transportError = (kind = 'network') =>
  llmError('ProviderShared', 'request', {
    _tag: 'Transport',
    message: 'connection reset',
    kind,
    url: 'https://example.test/chat',
  })

describe('retry delay', () => {
  it('uses exponential backoff without headers', () => {
    expect(delay(1)).toBe(2_000)
    expect(delay(2)).toBe(4_000)
    expect(delay(3)).toBe(8_000)
  })

  it('caps at RETRY_MAX_DELAY_NO_HEADERS (30s) without headers', () => {
    expect(delay(10)).toBe(30_000)
  })

  it('honors retry-after-ms header', () => {
    expect(delay(1, rateLimitError({ 'retry-after-ms': '750' }))).toBe(750)
  })

  it('honors retry-after seconds header', () => {
    expect(delay(1, rateLimitError({ 'retry-after': '3' }))).toBe(3_000)
  })

  it('falls back to exponential when header unparseable', () => {
    expect(delay(1, rateLimitError({ 'retry-after': 'not-a-date' }))).toBe(2_000)
  })

  it('honors retry-after as an HTTP date in the future', () => {
    const future = new Date(Date.now() + 5000).toUTCString()
    const result = delay(1, rateLimitError({ 'retry-after': future }))
    // Date.parse(future) - now is ~5000ms (slightly less due to elapsed time).
    expect(result).toBeGreaterThan(4_000)
    expect(result).toBeLessThanOrEqual(5_000)
  })

  it('falls back to exponential when retry-after HTTP date is in the past', () => {
    const past = new Date(Date.now() - 10_000).toUTCString()
    expect(delay(1, rateLimitError({ 'retry-after': past }))).toBe(2_000)
  })
})

describe('retry retryable', () => {
  it('marks RateLimit as retryable', () => {
    expect(retryable(rateLimitError())).toBeDefined()
  })

  it('rejects context overflow', () => {
    expect(retryable(overflowError())).toBeUndefined()
  })

  it('rejects non-LLMError', () => {
    expect(retryable(new Error('x'))).toBeUndefined()
  })

  it('marks a transient Transport error as retryable', () => {
    expect(retryable(transportError('network'))).toBeDefined()
  })

  it('rejects a mid-stream Transport error', () => {
    expect(retryable(transportError('stream_interrupted'))).toBeUndefined()
  })
})

describe('retry withRetry Transport', () => {
  it('retries a transient Transport (network) error then succeeds', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls += 1
        if (calls < 3) throw transportError('network')
        return 'ok'
      },
      { maxRetries: 5, sleep: async () => {} },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('does not retry a mid-stream Transport disconnect', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw transportError('stream_interrupted')
        },
        { maxRetries: 5, sleep: async () => {} },
      ),
    ).rejects.toBeDefined()
    expect(calls).toBe(1)
  })

  it('caps at 3 total attempts even when the caller allows more, throwing the last error', async () => {
    let calls = 0
    const attempts: number[] = []
    const delays: number[] = []
    const thrown = await withRetry(
      async () => {
        calls += 1
        throw transportError('network')
      },
      {
        maxRetries: 5,
        sleep: async () => {},
        onRetry: (i) => {
          attempts.push(i.attempt)
          delays.push(i.delayMs)
        },
      },
    ).catch((e) => e)
    expect(isLLMError(thrown)).toBe(true)
    if (isLLMError(thrown)) expect(thrown.reason._tag).toBe('Transport')
    expect(calls).toBe(3)
    expect(attempts).toEqual([1, 2])
    // Exponential backoff (2s, 4s), both within the 5s Transport ceiling.
    expect(delays).toEqual([2_000, 4_000])
  })

  it('does not let the Transport cap leak into RateLimit (no regression)', async () => {
    // RateLimit must still honor the caller's maxRetries (4 → 5 attempts),
    // proving the per-reason Transport cap is scoped to Transport only.
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw rateLimitError()
        },
        { maxRetries: 4, sleep: async () => {} },
      ),
    ).rejects.toBeDefined()
    expect(calls).toBe(5)
  })
})

describe('retry withRetry', () => {
  it('retries a retryable error then succeeds', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls += 1
        if (calls < 3) throw rateLimitError()
        return 'ok'
      },
      { maxRetries: 5, sleep: async () => {} },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('does not retry non-retryable errors', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw overflowError()
        },
        { maxRetries: 5, sleep: async () => {} },
      ),
    ).rejects.toBeDefined()
    expect(calls).toBe(1)
  })

  it('gives up after maxRetries', async () => {
    let calls = 0
    const attempts: number[] = []
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw rateLimitError()
        },
        { maxRetries: 2, sleep: async () => {}, onRetry: (i) => attempts.push(i.attempt) },
      ),
    ).rejects.toBeDefined()
    expect(calls).toBe(3)
    expect(attempts).toEqual([1, 2])
  })
})
