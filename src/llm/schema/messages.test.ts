import { describe, expect, it } from 'vitest'
import type { InternalRequest, Message, ToolDefinition } from './messages.js'
import { messageAssistant, messageSystem, messageUser, requestUpdate } from './messages.js'
import { model } from './options.js'

describe('schema/messages factories', () => {
  it('messageUser wraps a string in a text part', () => {
    const m: Message = messageUser('hello')
    expect(m.role).toBe('user')
    expect(m.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('messageAssistant builds an assistant message', () => {
    expect(messageAssistant('ok').role).toBe('assistant')
  })

  it('messageSystem builds a system message', () => {
    expect(messageSystem('be nice').role).toBe('system')
  })
})

describe('schema/messages requestUpdate', () => {
  it('patches an InternalRequest immutably', () => {
    const tools: ToolDefinition[] = [
      { name: 'echo', description: 'd', inputSchema: { type: 'object' } },
    ]
    const req: InternalRequest = {
      model: model('gpt-4o', 'openai'),
      system: [{ type: 'text', text: 'sys' }],
      messages: [messageUser('hi')],
      tools,
    }
    const updated = requestUpdate(req, {
      generation: { temperature: 0.7 },
    })
    expect(updated.generation?.temperature).toBe(0.7)
    expect(req.generation).toBeUndefined()
    expect(updated.tools).toBe(tools)
  })
})
