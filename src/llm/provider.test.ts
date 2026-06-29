import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRequest } from '../shared/types/llm.js'
import { bodyFrom } from './protocols/openai-compat.js'
import { buildInternalRequest, chat, chatStream } from './provider.js'
import { createRegistry, registerProvider } from './registry.js'

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
  it('streams text deltas + usage + done (separate trailing usage chunk)', async () => {
    // Real OpenAI format: finish_reason chunk has NO usage; usage arrives in a
    // separate trailing chunk with choices: [] when stream_options.include_usage.
    const sse = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
    ]
      .map((l) => `${l}\n\n`)
      .join('')
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
    const usage = chunks.find((c) => c._tag === 'usage') as
      | { inputTokens: number; outputTokens: number }
      | undefined
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

  it('streams a tool call through start/delta/end (single end)', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"echo","arguments":"{\\"x\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
    ]
      .map((l) => `${l}\n\n`)
      .join('')
    const ctx = setup(sse)
    const chunks = []
    for await (const c of chatStream(ctx, request(), { provider: 'mock', model: 'm1' })) {
      chunks.push(c)
    }
    expect(chunks.some((c) => c._tag === 'tool_call_start')).toBe(true)
    expect(chunks.some((c) => c._tag === 'tool_call_delta')).toBe(true)
    // Exactly one tool_call_end per tool (the finalized tool-call event).
    expect(chunks.filter((c) => c._tag === 'tool_call_end')).toHaveLength(1)
    const end = chunks.find((c) => c._tag === 'tool_call_end') as
      | { argumentsFinal?: string }
      | undefined
    expect(end?.argumentsFinal).toBe('{"x":1}')
  })
})

describe('provider chat (non-streaming)', () => {
  it('returns the joined text', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"foo"}}]}',
      'data: {"choices":[{"delta":{"content":"bar"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ]
      .map((l) => `${l}\n\n`)
      .join('')
    const ctx = setup(sse)
    const text = await chat(ctx, request(), { provider: 'mock', model: 'm1' })
    expect(text).toBe('foobar')
  })
})

describe('toInternalMessage tool-call-id preservation', () => {
  // 回归：context.ts 对 tool 消息返回 string content + toolCallId 字段。
  // toInternalMessage 必须在 string-content early return 之前处理 tool 消息，
  // 否则 toolCallId 丢失 → 发给 provider 的 tool 消息没有 tool_call_id →
  // "invalid tool_call_id"。
  it('preserves toolCallId for tool messages with string content', () => {
    const req: ChatRequest = {
      model: 'm1',
      messages: [
        {
          role: 'tool',
          content: '{"_tag":"success","output":"data"}',
          toolCallId: 'call_abc123',
        } as ChatMessage,
      ],
      stream: true,
    }
    const internal = buildInternalRequest(req, 'mock', 'm1')
    const body = bodyFrom(internal)
    const toolMsg = body.messages[0]
    expect(toolMsg?.role).toBe('tool')
    expect(toolMsg?.tool_call_id).toBe('call_abc123')
  })
})
