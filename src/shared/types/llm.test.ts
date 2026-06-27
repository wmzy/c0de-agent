import { describe, expect, it } from 'vitest'
import type {
  ChatMessage,
  ChatRequest,
  ChatTool,
  ContentPart,
  ModelCapabilities,
  ModelRole,
  ProviderConfig,
  StreamChunk,
} from './llm.js'

describe('ProviderConfig', () => {
  it('creates an openai-compat provider', () => {
    const config: ProviderConfig = {
      name: 'deepseek',
      protocol: 'openai-compat',
      apiKey: 'sk-xxx',
      baseURL: 'https://api.deepseek.com/v1',
    }
    expect(config.protocol).toBe('openai-compat')
  })
})

describe('ModelRole', () => {
  it('creates all role variants', () => {
    const roles: ModelRole[] = [
      { _tag: 'default' },
      { _tag: 'smol' },
      { _tag: 'slow' },
      { _tag: 'plan' },
      { _tag: 'commit' },
    ]
    expect(roles).toHaveLength(5)
  })
})

describe('ContentPart', () => {
  it('creates a text part', () => {
    const part: ContentPart = { type: 'text', text: 'hello' }
    expect(part.type).toBe('text')
  })

  it('creates an image part', () => {
    const part: ContentPart = {
      type: 'image',
      mediaType: 'image/png',
      data: 'iVBORw0KGgo=',
    }
    expect(part.type).toBe('image')
  })
})

describe('ChatMessage', () => {
  it('creates a simple text message', () => {
    const msg: ChatMessage = { role: 'user', content: 'Hello' }
    expect(msg.role).toBe('user')
  })

  it('creates a message with tool calls', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc-1', name: 'read', arguments: '{"path":"a.ts"}' }],
    }
    expect(msg.toolCalls).toHaveLength(1)
  })
})

describe('ChatTool', () => {
  it('creates a tool definition', () => {
    const tool: ChatTool = {
      name: 'read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }
    expect(tool.name).toBe('read')
  })
})

describe('ChatRequest', () => {
  it('creates a streaming request', () => {
    const req: ChatRequest = {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }
    expect(req.stream).toBe(true)
  })
})

describe('StreamChunk', () => {
  it('creates a text chunk', () => {
    const chunk: StreamChunk = { _tag: 'text', text: 'hello' }
    expect(chunk._tag).toBe('text')
  })

  it('creates a tool_call_start chunk', () => {
    const chunk: StreamChunk = {
      _tag: 'tool_call_start',
      id: 'tc-1',
      name: 'read',
    }
    expect(chunk._tag).toBe('tool_call_start')
  })

  it('creates a usage chunk', () => {
    const chunk: StreamChunk = {
      _tag: 'usage',
      inputTokens: 100,
      outputTokens: 50,
    }
    if (chunk._tag === 'usage') {
      expect(chunk.inputTokens).toBe(100)
    }
  })

  it('creates a done chunk', () => {
    const chunk: StreamChunk = { _tag: 'done' }
    expect(chunk._tag).toBe('done')
  })
})

describe('ModelCapabilities', () => {
  it('creates a capability descriptor', () => {
    const caps: ModelCapabilities = {
      contextWindow: 128_000,
      maxOutput: 16_384,
      supportsTools: true,
      supportsVision: true,
      supportsThinking: false,
      costPer1kInput: 0.005,
      costPer1kOutput: 0.015,
    }
    expect(caps.contextWindow).toBe(128_000)
  })
})
