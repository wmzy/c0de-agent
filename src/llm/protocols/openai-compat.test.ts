import { describe, expect, it } from 'vitest'
import {
  bodyFrom,
  initialStepState,
  mapFinishReason,
  openAICompatRoute,
  parseChunk,
  step,
} from './openai-compat.js'
import { isLLMError } from '../schema/errors.js'
import { model } from '../schema/options.js'
import { messageAssistant, messageUser } from '../schema/messages.js'
import type { InternalRequest, Message, ToolDefinition } from '../schema/messages.js'

const request = (extra?: Partial<InternalRequest>): InternalRequest => ({
  model: model('gpt-4o', 'openai'),
  system: [{ type: 'text', text: 'be nice' }],
  messages: [messageUser('hi')],
  tools: [],
  ...extra,
})

describe('openai-compat bodyFrom', () => {
  it('builds a basic chat body with system message', () => {
    const body = bodyFrom(request())
    expect(body.model).toBe('gpt-4o')
    expect(body.stream).toBe(true)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be nice' })
    expect(body.messages[1]?.role).toBe('user')
  })

  it('includes tools and tool_choice when provided', () => {
    const tools: ToolDefinition[] = [
      { name: 'echo', description: 'd', inputSchema: { type: 'object', properties: {} } },
    ]
    const body = bodyFrom(request({ tools, toolChoice: { type: 'auto' } }))
    expect(body.tools?.[0]?.function.name).toBe('echo')
    expect(body.tool_choice).toBe('auto')
  })

  it('maps assistant tool-call content to tool_calls', () => {
    const msg = messageAssistant('thinking...')
    msg.content.push({ type: 'tool-call', id: 't1', name: 'echo', input: { x: 1 } })
    const body = bodyFrom(request({ messages: [messageUser('hi'), msg] }))
    const assistant = body.messages.find((m) => m.role === 'assistant')
    expect(assistant?.tool_calls?.[0]?.function.name).toBe('echo')
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe('{"x":1}')
  })

  it('maps tool-result message to tool role', () => {
    const toolMsg: Message = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          id: 't1',
          name: 'echo',
          result: { type: 'text', value: 'done' },
        },
      ],
    }
    const body = bodyFrom(request({ messages: [messageUser('hi'), toolMsg] }))
    const tool = body.messages.find((m) => m.role === 'tool')
    expect(tool?.tool_call_id).toBe('t1')
    expect(tool?.content).toBe('done')
  })

  it('applies generation options', () => {
    const body = bodyFrom(request({ generation: { maxTokens: 100, temperature: 0.5 } }))
    expect(body.max_tokens).toBe(100)
    expect(body.temperature).toBe(0.5)
  })
})

describe('openai-compat step', () => {
  it('emits text deltas then finish', () => {
    let state = initialStepState()
    const allEvents: ReturnType<typeof step>['events'][number][] = []
    let res = step(state, { choices: [{ delta: { content: 'hel' } }] })
    state = res.state
    allEvents.push(...res.events)
    res = step(state, { choices: [{ delta: { content: 'lo' } }] })
    state = res.state
    allEvents.push(...res.events)
    res = step(state, {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    })
    expect(res.done).toBe(true)
    const textDeltas = allEvents
      .filter((e) => e.type === 'text-delta')
      .map((e) => (e as { text: string }).text)
    expect(textDeltas.join('')).toBe('hello')
    const finish = res.events.find((e) => e.type === 'finish')
    expect(finish && 'usage' in finish && finish.usage?.totalTokens).toBe(7)
  })

  it('maps reasoning_content to reasoning deltas (DeepSeek)', () => {
    const res = step(initialStepState(), {
      choices: [{ delta: { reasoning_content: 'think' } }],
    })
    expect(res.events.some((e) => e.type === 'reasoning-delta')).toBe(true)
  })

  it('accumulates streaming tool calls and finalizes them', () => {
    let state = initialStepState()
    let res = step(state, {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 't1', function: { name: 'echo', arguments: '{"x":' } }],
          },
        },
      ],
    })
    state = res.state
    res = step(state, {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }],
    })
    state = res.state
    res = step(state, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    const toolCall = res.events.find((e) => e.type === 'tool-call')
    expect(toolCall && 'input' in toolCall && toolCall.input).toEqual({ x: 1 })
  })

  it('maps finish reasons', () => {
    expect(mapFinishReason('stop')).toBe('stop')
    expect(mapFinishReason('tool_calls')).toBe('tool-calls')
    expect(mapFinishReason('length')).toBe('length')
    expect(mapFinishReason('content_filter')).toBe('content-filter')
    expect(mapFinishReason(undefined)).toBe('unknown')
  })
})

describe('openai-compat parseChunk + route', () => {
  it('parses valid JSON', () => {
    const chunk = parseChunk('openai-chat', '{"choices":[]}')
    expect(chunk.choices).toEqual([])
  })

  it('throws InvalidProviderOutput on bad JSON', () => {
    try {
      parseChunk('openai-chat', '{bad')
      throw new Error('should not reach')
    } catch (e) {
      expect(isLLMError(e)).toBe(true)
    }
  })

  it('builds a route config', () => {
    const route = openAICompatRoute({
      id: 'deepseek',
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-x',
    })
    expect(route.path).toBe('/v1/chat/completions')
    expect(route.auth).toEqual({ type: 'bearer', apiKey: 'sk-x' })
  })
})
