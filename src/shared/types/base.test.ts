import { describe, expect, it } from 'vitest'
import type { JSONSchema, MessageRole, SessionRef } from './base.js'

describe('JSONSchema', () => {
  it('allows a simple object schema', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    }
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['path'])
  })

  it('allows nested schemas', () => {
    const schema: JSONSchema = {
      type: 'array',
      items: {
        type: 'string',
      },
    }
    expect(schema.items).toEqual({ type: 'string' })
  })
})

describe('MessageRole', () => {
  it('accepts all valid roles', () => {
    const roles: MessageRole[] = ['user', 'assistant', 'system', 'tool']
    expect(roles).toHaveLength(4)
  })
})

describe('SessionRef', () => {
  it('creates a session reference', () => {
    const ref: SessionRef = { id: 'sess-1', cwd: '/home/user/project' }
    expect(ref.id).toBe('sess-1')
    expect(ref.cwd).toBe('/home/user/project')
  })
})
