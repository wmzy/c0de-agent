import { describe, it, expect } from 'vitest'
import type { JSONSchema } from '../shared/types/base.js'
import { validateInput } from './validate.js'

describe('validateInput', () => {
  it('validates a simple object schema', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['path'],
    }
    expect(validateInput(schema, { path: 'foo.ts' })).toEqual({ valid: true })
    expect(validateInput(schema, { path: 'foo.ts', limit: 10 })).toEqual({ valid: true })
  })

  it('reports missing required fields', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    const result = validateInput(schema, {})
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain('path')
    }
  })

  it('reports wrong type', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    const result = validateInput(schema, { path: 123 })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain('path')
      expect(result.error).toContain('string')
    }
  })

  it('validates integer type', () => {
    const schema: JSONSchema = { type: 'integer' }
    expect(validateInput(schema, 42)).toEqual({ valid: true })
    expect(validateInput(schema, 3.14).valid).toBe(false)
    expect(validateInput(schema, '42').valid).toBe(false)
  })

  it('validates boolean type', () => {
    const schema: JSONSchema = { type: 'boolean' }
    expect(validateInput(schema, true)).toEqual({ valid: true })
    expect(validateInput(schema, false)).toEqual({ valid: true })
    expect(validateInput(schema, 'true').valid).toBe(false)
  })

  it('validates array type with items', () => {
    const schema: JSONSchema = {
      type: 'array',
      items: { type: 'string' },
    }
    expect(validateInput(schema, ['a', 'b'])).toEqual({ valid: true })
    expect(validateInput(schema, ['a', 1]).valid).toBe(false)
  })

  it('validates enum values', () => {
    const schema: JSONSchema = { type: 'string', enum: ['auto', 'ask', 'deny'] }
    expect(validateInput(schema, 'auto')).toEqual({ valid: true })
    expect(validateInput(schema, 'maybe').valid).toBe(false)
  })

  it('validates anyOf schemas', () => {
    const schema: JSONSchema = {
      anyOf: [{ type: 'string' }, { type: 'number' }],
    }
    expect(validateInput(schema, 'hello')).toEqual({ valid: true })
    expect(validateInput(schema, 42)).toEqual({ valid: true })
    expect(validateInput(schema, true).valid).toBe(false)
  })

  it('reports additionalProperties when false', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    }
    expect(validateInput(schema, { a: 'x' })).toEqual({ valid: true })
    expect(validateInput(schema, { a: 'x', b: 1 }).valid).toBe(false)
  })

  it('accepts null input for nullable schemas', () => {
    const schema: JSONSchema = { type: 'null' }
    expect(validateInput(schema, null)).toEqual({ valid: true })
    expect(validateInput(schema, 'x').valid).toBe(false)
  })

  it('handles nested objects', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: { inner: { type: 'string' } },
          required: ['inner'],
        },
      },
      required: ['outer'],
    }
    expect(validateInput(schema, { outer: { inner: 'val' } })).toEqual({ valid: true })
    expect(validateInput(schema, { outer: {} }).valid).toBe(false)
  })

  it('returns valid for empty schema', () => {
    expect(validateInput({}, { anything: true })).toEqual({ valid: true })
    expect(validateInput({}, 'anything')).toEqual({ valid: true })
  })
})
