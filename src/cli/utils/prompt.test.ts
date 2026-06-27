import { describe, expect, it } from 'vitest'
import type { PromptInterface } from './prompt.js'
import { confirm } from './prompt.js'

function mockRl(answer: string): PromptInterface {
  return {
    question: async () => answer,
    close: () => {},
  }
}

describe('confirm', () => {
  it('returns true on y/yes (case-insensitive)', async () => {
    for (const input of ['y', 'Y', 'yes', 'YES']) {
      const res = await confirm('ok?', { rl: mockRl(input) })
      expect(res).toBe(true)
    }
  })

  it('returns false on n/no/garbage', async () => {
    for (const input of ['n', 'no', 'garbage']) {
      const res = await confirm('ok?', { rl: mockRl(input) })
      expect(res).toBe(false)
    }
  })

  it('uses default when input empty', async () => {
    const res = await confirm('ok?', { rl: mockRl(''), defaultYes: true })
    expect(res).toBe(true)
  })
})
