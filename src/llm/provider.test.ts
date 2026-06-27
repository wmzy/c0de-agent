import { describe, expect, it } from 'vitest'
import type { ChatRequest } from '../shared/types/llm.js'
import { createRegistry, registerProvider } from './registry.js'
import { chat, chatStream } from './provider.js'

const sseFetch = (body: string): typeof fetch =>
  (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch

const setup = (body: string) => {
  const registry = createRegistry()
  registerProvider(registry, { name: 'mock', baseURL: 'https://mock', apiKey: 'k' })
  const ctx = { registry, fetchImpl: sseFetch(body) }
  return ctx
}

const request = (): ChatRequest => ({
  model: 'm1',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
})

describe('provider chatStream', () => {
  it('streams text deltas + usage + done', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    ].join('')
    const ctx = setup(sse)
    const chunks = []
    for await (const c of chatStream(ctx, request(), { provider: 'mock', model: 'm1' })) {
      chunks.push(c)
    }
    const text = chunks
      .filter((c) => c._tag === 'text')
      .map((c) => (c as { text: string }).text)
      .join('')
    expect(text).toBe('hello')
    expect(chunks.some((c) => c._tag === 'done')).toBe(true)
    const usage = chunks.find((c) => c._tag === 'usage') as {
      inputTokens: number
      outputTokens: number
    } | undefined
    expect(usage?.inputTokens).toBe(3)
  })

  it('streams thinking from reasoning_content', async () => {
    const sse = 'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n'
    const ctx = setup(sse)
    const chunks = []
    for await (const c of chatStream(ctx, request(), { provider: 'mock', model: 'm1' })) {
      chunks.push(c)
    }
    expect(chunks.some((c) => c._tag === 'thinking')).toBe(true)
  })

  it('streams a tool call through start/delta/end', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"echo","arguments":"{\\"x\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    ].join('')
    const ctx = setup(sse)
    const chunks = []
    for await (const c of chatStream(ctx, request(), { provider: 'mock', model: 'm1' })) {
      chunks.push(c)
    }
    expect(chunks.some((c) => c._tag === 'tool_call_start')).toBe(true)
    expect(chunks.some((c) => c._tag === 'tool_call_delta')).toBe(true)
    expect(chunks.some((c) => c._tag === 'tool_call_end')).toBe(true)
  })
})

describe('provider chat (non-streaming)', () => {
  it('returns the joined text', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"foo"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"bar"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    ].join('')
    const ctx = setup(sse)
    const text = await chat(ctx, request(), { provider: 'mock', model: 'm1' })
    expect(text).toBe('foobar')
  })
})
