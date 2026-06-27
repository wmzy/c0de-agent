import { describe, expect, it } from 'vitest'
import type { Message } from '../shared/types/message.js'
import type { CompactionConfig } from './config.js'
import { createTokenBudget, estimateBudget, fitToBudget, shouldCompact } from './context.js'

function makeMessage(text: string): Message {
  return {
    id: Math.random().toString(36),
    sessionId: 's1',
    role: 'user',
    content: [{ _tag: 'text', text }],
    tokenCount: 0,
    createdAt: Date.now(),
  }
}

describe('createTokenBudget', () => {
  it('allocates reserved/available from total', () => {
    const b = createTokenBudget(100_000)
    expect(b.total).toBe(100_000)
    expect(b.reserved).toBe(20_000)
    expect(b.available).toBe(80_000)
    expect(b.used).toBe(0)
    expect(b.keepRecent).toBe(10_000)
  })

  it('respects custom keepRecent', () => {
    const b = createTokenBudget(100_000, { keepRecent: 5_000 })
    expect(b.keepRecent).toBe(5_000)
  })
})

describe('estimateBudget', () => {
  it('sums token counts of messages', () => {
    const msgs = [makeMessage('hello'), makeMessage('world')]
    const used = estimateBudget(msgs)
    expect(used).toBeGreaterThan(0)
  })
})

describe('fitToBudget', () => {
  it('returns all messages when within budget', () => {
    const msgs = [makeMessage('hi')]
    const budget = createTokenBudget(100_000)
    budget.used = estimateBudget(msgs)
    const fitted = fitToBudget(msgs, budget)
    expect(fitted).toHaveLength(1)
  })

  it('drops oldest non-system messages when over budget', () => {
    const msgs: Message[] = []
    for (let i = 0; i < 100; i++) {
      msgs.push(makeMessage(`message number ${i} `.repeat(50)))
    }
    const budget = createTokenBudget(2_000)
    const fitted = fitToBudget(msgs, budget)
    expect(fitted.length).toBeLessThan(msgs.length)
    expect(fitted[fitted.length - 1]).toBe(msgs[msgs.length - 1])
  })

  it('always keeps the last N messages (keepRecent)', () => {
    const msgs: Message[] = []
    for (let i = 0; i < 50; i++) {
      msgs.push(makeMessage('x'.repeat(200)))
    }
    const budget = createTokenBudget(500, { keepRecent: 5 })
    const fitted = fitToBudget(msgs, budget)
    expect(fitted.length).toBeGreaterThanOrEqual(5)
  })
})

describe('shouldCompact', () => {
  const cfg: CompactionConfig = {
    enabled: true,
    threshold: 0.8,
    reserveTokens: 1000,
    keepRecentTokens: 500,
  }

  it('returns false when disabled', () => {
    const budget = createTokenBudget(10_000)
    budget.used = 9_000
    expect(shouldCompact([], budget, { ...cfg, enabled: false })).toBe(false)
  })

  it('returns true when usage exceeds threshold', () => {
    const budget = createTokenBudget(10_000)
    budget.used = 8_500
    expect(shouldCompact([], budget, cfg)).toBe(true)
  })

  it('returns false when usage is under threshold', () => {
    const budget = createTokenBudget(10_000)
    budget.used = 5_000
    expect(shouldCompact([], budget, cfg)).toBe(false)
  })
})
