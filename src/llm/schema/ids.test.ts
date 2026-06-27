import { describe, expect, it } from 'vitest'
import { modelId, providerId } from './ids.js'
import type { ModelID, ProviderID } from './ids.js'

describe('schema/ids', () => {
  it('brands a string as ModelID', () => {
    const id: ModelID = modelId('gpt-4o')
    expect(id).toBe('gpt-4o')
  })

  it('brands a string as ProviderID', () => {
    const id: ProviderID = providerId('openai')
    expect(id).toBe('openai')
  })

  it('treats branded ids as assignable to string', () => {
    const id: ModelID = modelId('deepseek-chat')
    const s: string = id
    expect(s).toBe('deepseek-chat')
  })
})
