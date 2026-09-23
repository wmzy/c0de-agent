import { describe, expect, it } from 'vitest'
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

  // 回归：JSON.parse('1e999') → Infinity 可经模型 JSON 参数真实到达。此前
  // typeof Infinity === 'number' 且非 NaN，通过校验后进入 slice/setTimeout/
  // max() 等算术，静默产生错误行为（read 空切片、bash 1ms 秒杀、kanban
  // max(position) 恒 Infinity）。
  it('rejects non-finite numbers for number type', () => {
    const schema: JSONSchema = { type: 'number' }
    expect(validateInput(schema, Number.POSITIVE_INFINITY).valid).toBe(false)
    expect(validateInput(schema, Number.NEGATIVE_INFINITY).valid).toBe(false)
    expect(validateInput(schema, Number.NaN).valid).toBe(false)
    expect(validateInput(schema, 42).valid).toBe(true)
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

  // 回归：anyOf/oneOf 与兄弟关键字在 JSON Schema 里是合取关系——此前
  // anyOf 命中即 return null，type/properties/required 兄弟校验整体短路
  // （task 工具 schema 的 properties 类型检查形同虚设：prompt: 123 恒通过，
  // tasks 条目缺 assignment 恒通过，静默派出 prompt=undefined 的子 agent）。
  it('anyOf 命中后仍继续校验 type/properties 兄弟关键字', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      anyOf: [{ required: ['prompt'] }, { required: ['context'] }],
    }
    expect(validateInput(schema, { prompt: 'ok' }).valid).toBe(true)
    expect(validateInput(schema, { context: 'ok' }).valid).toBe(true)
    // anyOf 分支命中（prompt 存在），但兄弟关键字 type=string 必须拒绝
    expect(validateInput(schema, { prompt: 123 }).valid).toBe(false)
    // 值非对象：{required} 分支对非对象空真，type=object 兄弟必须拒绝
    expect(validateInput(schema, 'not-an-object').valid).toBe(false)
    expect(validateInput(schema, null).valid).toBe(false)
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

// 复现：结构关键字（required/properties/items/additionalProperties）此前只在
// 同一 schema 节点声明了 `type` 时才被校验——JSON Schema 语义里它们与 type 是
// **独立**约束（`{required:['prompt']}` 对对象实例同样生效，不要求同层 type）。
// task 工具的 anyOf 分支恰是 `{required:['prompt']}` / `{required:['context','tasks']}`
// （无 type）：二选一守卫因此完全失效，`{}`、`{subagent_type:'coder'}` 一律通过，
// 直到 execute 的运行时兜底才报错。
describe('validateInput 结构关键字不依赖同层 type 声明', () => {
  it('anyOf 分支的 required 生效（task 工具二选一守卫）', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        context: { type: 'string' },
        tasks: { type: 'array' },
      },
      anyOf: [{ required: ['prompt'] }, { required: ['context', 'tasks'] }],
    }
    expect(validateInput(schema, {}).valid).toBe(false)
    expect(validateInput(schema, { subagent_type: 'coder' }).valid).toBe(false)
    expect(validateInput(schema, { context: 'shared' }).valid).toBe(false)
    expect(validateInput(schema, { tasks: [] }).valid).toBe(false)
    expect(validateInput(schema, { prompt: 'do it' }).valid).toBe(true)
    expect(validateInput(schema, { context: 'shared', tasks: [] }).valid).toBe(true)
  })

  it('裸 required 对对象实例生效，且不误伤非对象', () => {
    expect(validateInput({ required: ['a'] }, {}).valid).toBe(false)
    expect(validateInput({ required: ['a'] }, { a: 1 }).valid).toBe(true)
    // required 只约束对象实例（JSON Schema 语义）：非对象原样通过
    expect(validateInput({ required: ['a'] }, 'str').valid).toBe(true)
    expect(validateInput({ required: ['a'] }, null).valid).toBe(true)
  })

  it('required 只认自有属性（原型链上的同名键不算存在）', () => {
    // `'toString' in {}` 恒真——此前据此判定会把缺失字段当成已提供
    expect(validateInput({ required: ['toString'] }, {}).valid).toBe(false)
    expect(validateInput({ required: ['constructor'] }, {}).valid).toBe(false)
    expect(validateInput({ required: ['toString'] }, { toString: 'x' }).valid).toBe(true)
  })

  it('裸 properties 校验属性类型', () => {
    const schema: JSONSchema = { properties: { a: { type: 'string' } } }
    expect(validateInput(schema, { a: 'ok' }).valid).toBe(true)
    expect(validateInput(schema, { a: 1 }).valid).toBe(false)
  })

  it('裸 items 校验数组元素，且不误伤非数组', () => {
    const schema: JSONSchema = { items: { type: 'string' } }
    expect(validateInput(schema, ['a', 'b']).valid).toBe(true)
    expect(validateInput(schema, [1]).valid).toBe(false)
    expect(validateInput(schema, 'not-an-array').valid).toBe(true)
  })

  it('additionalProperties:false 无 type 声明时同样生效', () => {
    const schema: JSONSchema = {
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    }
    expect(validateInput(schema, { a: 'x' }).valid).toBe(true)
    expect(validateInput(schema, { a: 'x', b: 1 }).valid).toBe(false)
  })
})
