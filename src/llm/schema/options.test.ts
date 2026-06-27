import { describe, expect, it } from 'vitest'
import {
  mergeGenerationOptions,
  mergeHttpOptions,
  mergeProviderOptions,
  model,
  modelUpdate,
} from './options.js'

describe('schema/options Model', () => {
  it('builds a model with branded ids', () => {
    const m = model('gpt-4o', 'openai', { context: 128000, output: 16384 })
    expect(m.id).toBe('gpt-4o')
    expect(m.provider).toBe('openai')
    expect(m.limits?.context).toBe(128000)
  })

  it('patches model limits immutably', () => {
    const m = model('gpt-4o', 'openai', { context: 128000 })
    const m2 = modelUpdate(m, { output: 4096 })
    expect(m2.limits).toEqual({ context: 128000, output: 4096 })
    expect(m.limits?.output).toBeUndefined()
  })
})

describe('schema/options merge', () => {
  it('merges generation options with later winning', () => {
    const merged = mergeGenerationOptions({ temperature: 0.5 }, { temperature: 0.9, topP: 1 })
    expect(merged).toEqual({ temperature: 0.9, topP: 1 })
  })

  it('returns undefined when all undefined', () => {
    expect(mergeGenerationOptions(undefined, undefined)).toBeUndefined()
  })

  it('merges http headers without losing keys', () => {
    const merged = mergeHttpOptions({ headers: { a: '1', b: '2' } }, { headers: { b: '3' } })
    expect(merged?.headers).toEqual({ a: '1', b: '3' })
  })

  it('deep-merges provider options per provider key', () => {
    const merged = mergeProviderOptions(
      { openai: { x: '1' } },
      { openai: { y: '2' }, deepseek: { z: '3' } },
    )
    expect(merged).toEqual({ openai: { x: '1', y: '2' }, deepseek: { z: '3' } })
  })
})
