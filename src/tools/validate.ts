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
  // 命中不短路：JSON Schema 中 anyOf/oneOf 与 type/required/properties 等
  // 兄弟关键字是**合取**关系——此前命中即 return null，兄弟校验整体失效
  // （task 工具 schema 的 properties 类型检查形同虚设：prompt: 123、
  // tasks 条目缺 assignment 均通过，静默派出 prompt=undefined 的子 agent）。
  if (schema.anyOf) {
    const passed = schema.anyOf.some((s) => validateNode(s, value, path) === null)
    if (!passed) return `${path || 'value'}: does not match anyOf schemas`
  }

  // oneOf: exactly one must pass
  if (schema.oneOf) {
    const count = schema.oneOf.filter((s) => validateNode(s, value, path) === null).length
    if (count !== 1)
      return `${path || 'value'}: must match exactly one oneOf schema (matched ${count})`
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
  // 结构关键字与 `type` 是**独立**约束：JSON Schema 语义下 required/properties/
  // additionalProperties 只对「对象实例」生效、items 只对「数组实例」生效，均
  // 不要求同一节点声明 type。task 工具的 anyOf 分支正是裸 `{required:['prompt']}`
  // ——此前整个对象校验块以 `schema.type === 'object'` 为前提，这类分支被整体跳过
  // （二选一守卫形同虚设：`{}`、`{subagent_type:'coder'}` 一律通过校验）。
  const isObjectValue = typeof value === 'object' && value !== null && !Array.isArray(value)
  const declaresObjectKeywords =
    schema.required !== undefined ||
    schema.properties !== undefined ||
    schema.additionalProperties !== undefined
  if (isObjectValue && declaresObjectKeywords) {
    const obj = value as Record<string, unknown>

    // required fields（只认自有属性：`'toString' in {}` 恒真，原型链上的同名键
    // 不代表实例真的携带该字段）
    if (schema.required) {
      for (const field of schema.required) {
        if (!Object.hasOwn(obj, field)) {
          return `${path ? `${path}.` : ''}${field}: missing required field`
        }
      }
    }

    // properties
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (Object.hasOwn(obj, key)) {
          const err = validateNode(propSchema, obj[key], path ? `${path}.${key}` : key)
          if (err) return err
        }
      }
    }

    // additionalProperties 两种形式（JSON Schema draft-07）：
    //  - false：只允许 properties 声明的键（未声明 properties 时任何键都是额外的）；
    //  - 模式（{type:'string'} 等）：每个**未被 properties 声明**的键按该模式校验
    //    （声明键只受自身 schema 约束，不受 additionalProperties 影响）。
    // 此前只实现 false 分支——声明 additionalProperties:{type:'string'} 的 schema
    // （bash 工具的 env 等）对未声明键完全放行：env:{FOO:123} 通过校验后进
    // spawn，值被 Node 静默字符串化（对象变 "[object Object]"）。
    if (schema.additionalProperties !== undefined) {
      const knownKeys = new Set(Object.keys(schema.properties ?? {}))
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!knownKeys.has(key)) {
            return `${path ? `${path}.` : ''}${key}: additional property not allowed`
          }
        }
      } else if (
        typeof schema.additionalProperties === 'object' &&
        schema.additionalProperties !== null
      ) {
        for (const [key, value] of Object.entries(obj)) {
          if (knownKeys.has(key)) continue
          const err = validateNode(
            schema.additionalProperties,
            value,
            path ? `${path}.${key}` : key,
          )
          if (err) return err
        }
      }
    }
  }

  // array validation（items 只对数组实例生效，同样不要求同层 type: 'array'）
  if (Array.isArray(value) && schema.items) {
    const itemSchema = Array.isArray(schema.items) ? schema.items : [schema.items]
    for (let i = 0; i < value.length; i++) {
      const s = itemSchema[i] ?? itemSchema[0]
      if (s) {
        const err = validateNode(s, value[i], `${path}[${i}]`)
        if (err) return err
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
      // JSON.parse('1e999') → Infinity 可真实到达（typeof number 且非 NaN），
      // 放行后进入 slice/setTimeout/max() 等算术即静默错误行为——一律拒绝。
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${label}: expected finite number, got ${typeof value}`
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
