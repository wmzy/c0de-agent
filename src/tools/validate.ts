import type { JSONSchema } from '../shared/types/base.js'
import type { ValidationResult } from './types.js'

/**
 * Validate a value against a JSON Schema (draft-07 subset).
 * Supports: type, required, properties, items, enum, additionalProperties, anyOf, oneOf.
 * No external dependency — lightweight custom implementation.
 */
export function validateInput(schema: JSONSchema, value: unknown): ValidationResult {
  const error = validateNode(schema, value, '')
  if (error) return { valid: false, error }
  return { valid: true }
}

function validateNode(schema: JSONSchema, value: unknown, path: string): string | null {
  // Empty schema accepts anything
  if (Object.keys(schema).length === 0) return null

  // anyOf: at least one must pass
  if (schema.anyOf) {
    const passed = schema.anyOf.some((s) => validateNode(s, value, path) === null)
    if (!passed) return `${path || 'value'}: does not match anyOf schemas`
    return null
  }

  // oneOf: exactly one must pass
  if (schema.oneOf) {
    const count = schema.oneOf.filter((s) => validateNode(s, value, path) === null).length
    if (count !== 1)
      return `${path || 'value'}: must match exactly one oneOf schema (matched ${count})`
    return null
  }

  // enum
  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value)) {
      return `${path || 'value'}: must be one of ${JSON.stringify(schema.enum)}`
    }
  }

  // type check
  if (schema.type) {
    const typeError = checkType(schema.type, value, path)
    if (typeError) return typeError
  }

  // object validation
  if (
    schema.type === 'object' &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>

    // required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in obj)) {
          return `${path ? `${path}.` : ''}${field}: missing required field`
        }
      }
    }

    // properties
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          const err = validateNode(propSchema, obj[key], path ? `${path}.${key}` : key)
          if (err) return err
        }
      }
    }

    // additionalProperties
    if (schema.additionalProperties === false && schema.properties) {
      const knownKeys = new Set(Object.keys(schema.properties))
      for (const key of Object.keys(obj)) {
        if (!knownKeys.has(key)) {
          return `${path ? `${path}.` : ''}${key}: additional property not allowed`
        }
      }
    }
  }

  // array validation
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.items) {
      const itemSchema = Array.isArray(schema.items) ? schema.items : [schema.items]
      for (let i = 0; i < value.length; i++) {
        const s = itemSchema[i] ?? itemSchema[0]
        if (s) {
          const err = validateNode(s, value[i], `${path}[${i}]`)
          if (err) return err
        }
      }
    }
  }

  return null
}

function checkType(type: string, value: unknown, path: string): string | null {
  const label = path || 'value'
  switch (type) {
    case 'string':
      if (typeof value !== 'string') return `${label}: expected string, got ${typeof value}`
      break
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return `${label}: expected number, got ${typeof value}`
      }
      break
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return `${label}: expected integer, got ${typeof value}`
      }
      break
    case 'boolean':
      if (typeof value !== 'boolean') return `${label}: expected boolean, got ${typeof value}`
      break
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `${label}: expected object`
      }
      break
    case 'array':
      if (!Array.isArray(value)) return `${label}: expected array, got ${typeof value}`
      break
    case 'null':
      if (value !== null) return `${label}: expected null, got ${typeof value}`
      break
    default:
      break
  }
  return null
}
