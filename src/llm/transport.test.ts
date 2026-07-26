import { describe, expect, it } from 'vitest'
import { isLLMError } from './schema/errors.js'
import { sseFraming, streamHTTP } from './transport.js'

const toStream = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

const collect = async (gen: AsyncGenerator<string>): Promise<string[]> => {
  const out: string[] = []
  for await (const frame of gen) out.push(frame)
  return out
}

/**
 * Build a ReadableStream that tracks reader cleanup. `readerCancels` counts
 * how often the acquired reader's `cancel()` is invoked (the fix under test);
 * `sourceCancels` counts how often the underlying source's `cancel()` runs —
 * the real signal that the transport was torn down. Note: in Bun
 * `reader.cancel()` does NOT flip `stream.locked`, so we assert on these
 * counters instead. `error` (instead of `close`) simulates an upstream
 * network failure so `reader.read()` rejects.
 */
const trackedStream = (
  chunks: string[],
  opts: { error?: Error } = {},
): {
  stream: ReadableStream<Uint8Array>
  readerCancels: () => number
  sourceCancels: () => number
} => {
  const encoder = new TextEncoder()
  let readerCancels = 0
  let sourceCancels = 0
  const base = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      if (opts.error) controller.error(opts.error)
      else controller.close()
    },
    cancel() {
      sourceCancels += 1
    },
  })
  const original = base.getReader.bind(base)
  base.getReader = (() => {
    const reader = original()
    const realCancel = reader.cancel.bind(reader)
    reader.cancel = () => {
      readerCancels += 1
      return realCancel()
    }
    return reader
  }) as typeof base.getReader
  return { stream: base, readerCancels: () => readerCancels, sourceCancels: () => sourceCancels }
}

describe('transport sseFraming', () => {
  it('parses a single data frame', async () => {
    const frames = await collect(sseFraming(toStream(['data: {"a":1}\n\n'])))
    expect(frames).toEqual(['{"a":1}'])
  })

  it('parses multiple frames across chunk boundaries', async () => {
    const frames = await collect(sseFraming(toStream(['data: {"a":1}\n\ndata: {"b":2}\n\n'])))
    expect(frames).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('handles split chunks', async () => {
    const frames = await collect(sseFraming(toStream(['data: {"a"', ':1}\n\n'])))
    expect(frames).toEqual(['{"a":1}'])
  })

  it('joins multi-line data fields', async () => {
    const frames = await collect(sseFraming(toStream(['data: line1\ndata: line2\n\n'])))
    expect(frames).toEqual(['line1\nline2'])
  })

  it('skips [DONE] sentinel and comments', async () => {
    const frames = await collect(
      sseFraming(toStream([': ping\ndata: [DONE]\n\ndata: {"x":1}\n\n'])),
    )
    expect(frames).toEqual(['{"x":1}'])
  })

  it('flushes a trailing frame without terminator', async () => {
    const frames = await collect(sseFraming(toStream(['data: {"tail":1}'])))
    expect(frames).toEqual(['{"tail":1}'])
  })
})

describe('transport sseFraming reader cleanup', () => {
  it('cancels the reader on normal completion', async () => {
    const { stream, readerCancels, sourceCancels } = trackedStream(['data: {"a":1}\n\n'])
    const frames = await collect(sseFraming(stream))
    expect(frames).toEqual(['{"a":1}'])
    // reader.cancel() is always invoked in the finally; the stream is already
    // closed by then so the underlying source has nothing to tear down.
    expect(readerCancels()).toBe(1)
    expect(sourceCancels()).toBe(0)
  })

  it('cancels the reader when the consumer throws mid-stream', async () => {
    const { stream, readerCancels, sourceCancels } = trackedStream([
      'data: {"a":1}\n\n',
      'data: {"b":2}\n\n',
    ])
    const gen = sseFraming(stream)
    await expect(
      (async () => {
        for await (const _frame of gen) throw new Error('consumer boom')
      })(),
    ).rejects.toThrow('consumer boom')
    // reader was released AND the still-readable transport was torn down.
    expect(readerCancels()).toBe(1)
    expect(sourceCancels()).toBe(1)
  })

  it('cancels the reader on early consumer break', async () => {
    const { stream, readerCancels, sourceCancels } = trackedStream([
      'data: {"a":1}\n\n',
      'data: {"b":2}\n\n',
    ])
    const gen = sseFraming(stream)
    const out: string[] = []
    for await (const frame of gen) {
      out.push(frame)
      break
    }
    expect(out).toEqual(['{"a":1}'])
    expect(readerCancels()).toBe(1)
    expect(sourceCancels()).toBe(1)
  })

  it('cancels the reader when the upstream stream errors', async () => {
    const { stream, readerCancels } = trackedStream(['data: {"a":1}\n\n'], {
      error: new Error('upstream broke'),
    })
    await expect(collect(sseFraming(stream))).rejects.toThrow('upstream broke')
    // reader.cancel() still runs in the finally even though read() rejected.
    expect(readerCancels()).toBe(1)
  })
})

describe('transport streamHTTP', () => {
  const makeFetch = (
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): typeof fetch =>
    (async () =>
      new Response(body, {
        status,
        headers: { 'content-type': 'text/event-stream', ...headers },
      })) as unknown as typeof fetch

  it('yields frames on a 200 response', async () => {
    const frames = await collect(
      streamHTTP({
        url: 'https://example.com',
        body: { q: 1 },
        headers: {},
        fetchImpl: makeFetch(200, 'data: {"ok":true}\n\n'),
      }),
    )
    expect(frames).toEqual(['{"ok":true}'])
  })

  it('throws Authentication on 401', async () => {
    await expect(
      collect(
        streamHTTP({
          url: 'https://example.com',
          body: {},
          headers: {},
          fetchImpl: makeFetch(401, 'bad key'),
        }),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isLLMError(e)) return false
      return e.reason._tag === 'Authentication'
    })
  })

  it('throws RateLimit on 429 and parses retry-after-ms', async () => {
    await expect(
      collect(
        streamHTTP({
          url: 'https://example.com',
          body: {},
          headers: {},
          fetchImpl: makeFetch(429, 'slow', { 'retry-after-ms': '500' }),
        }),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isLLMError(e)) return false
      return e.reason._tag === 'RateLimit' && e.reason.retryAfterMs === 500
    })
  })

  it('throws context-overflow InvalidRequest when body matches', async () => {
    await expect(
      collect(
        streamHTTP({
          url: 'https://example.com',
          body: {},
          headers: {},
          fetchImpl: makeFetch(400, "This model's maximum context length is 8192 tokens"),
        }),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isLLMError(e)) return false
      return e.reason._tag === 'InvalidRequest' && e.reason.classification === 'context-overflow'
    })
  })

  it('throws ProviderInternal on 5xx', async () => {
    await expect(
      collect(
        streamHTTP({
          url: 'https://example.com',
          body: {},
          headers: {},
          fetchImpl: makeFetch(503, 'overloaded'),
        }),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isLLMError(e)) return false
      return e.reason._tag === 'ProviderInternal'
    })
  })

  it('throws QuotaExceeded on 402', async () => {
    await expect(
      collect(
        streamHTTP({
          url: 'https://example.com',
          body: {},
          headers: {},
          fetchImpl: makeFetch(402, 'billing quota exceeded'),
        }),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isLLMError(e)) return false
      return e.reason._tag === 'QuotaExceeded'
    })
  })

  it('throws ContentPolicy when body mentions content filter', async () => {
    await expect(
      collect(
        streamHTTP({
          url: 'https://example.com',
          body: {},
          headers: {},
          fetchImpl: makeFetch(400, 'blocked by content filter'),
        }),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isLLMError(e)) return false
      return e.reason._tag === 'ContentPolicy'
    })
  })

  it('classifies bodyless 413 as context-overflow', async () => {
    await expect(
      collect(
        streamHTTP({
          url: 'https://example.com',
          body: {},
          headers: {},
          fetchImpl: makeFetch(413, ''),
        }),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isLLMError(e)) return false
      return e.reason._tag === 'InvalidRequest' && e.reason.classification === 'context-overflow'
    })
  })
})
