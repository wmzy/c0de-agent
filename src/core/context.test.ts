import { describe, expect, it } from 'vitest'
import type { Message } from '../shared/types/message.js'
import type { CompactionConfig } from './config.js'
import {
  calibrateEstimate,
  createTokenBudget,
  estimateBudget,
  fitToBudget,
  shouldCompact,
} from './context.js'

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
  it('allocates reserved/available/historyBudget from total (20/60/20)', () => {
    const b = createTokenBudget(100_000)
    expect(b.total).toBe(100_000)
    expect(b.reserved).toBe(20_000)
    expect(b.available).toBe(80_000)
    expect(b.historyBudget).toBe(60_000)
    expect(b.used).toBe(0)
    expect(b.keepRecent).toBe(10_000)
    // 当前轮次预留 = available - historyBudget = 20%
    expect(b.available - b.historyBudget).toBe(20_000)
  })

  it('respects custom historyBudget', () => {
    const b = createTokenBudget(100_000, { historyBudget: 40_000 })
    expect(b.historyBudget).toBe(40_000)
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

  it('caps non-recent history at historyBudget, not available', () => {
    // historyBudget=60、available=80；每条 ~10 tokens，8 条共 80。
    const budget = createTokenBudget(100, { keepRecent: 0 })
    const msgs = Array.from({ length: 8 }, () => makeMessage('x'.repeat(40)))
    const fitted = fitToBudget(msgs, budget)
    // 前 6 条填满 historyBudget(60)；第 7 条(index 6) 超限被丢弃；
    // 最后一条(index 7) 由 keepRecent 兜底保留。若按 available(80) 则会保留全部。
    expect(fitted).not.toContain(msgs[6])
    expect(fitted).toContain(msgs[7])
    expect(fitted).toHaveLength(7)
  })

  it('applies calibration factor to the history cap', () => {
    const budget = createTokenBudget(100, { keepRecent: 0 })
    const msgs = Array.from({ length: 8 }, () => makeMessage('x'.repeat(40)))
    // factor=2 使每条估算翻倍 → 前 3 条填满 historyBudget，更早丢弃
    const fitted = fitToBudget(msgs, budget, 2.0)
    expect(fitted.length).toBeLessThanOrEqual(4)
    expect(fitted[fitted.length - 1]).toBe(msgs[msgs.length - 1])
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

describe('calibrateEstimate', () => {
  it('returns prevFactor when estimated or actual is non-positive', () => {
    expect(calibrateEstimate(1.0, 0, 100)).toBe(1.0)
    expect(calibrateEstimate(1.5, 100, 0)).toBe(1.5)
    expect(calibrateEstimate(1.5, -1, 50)).toBe(1.5)
  })

  it('blends the observed ratio into prevFactor via EMA (alpha=0.3)', () => {
    // observed = 200/100 = 2.0 → 1.0*0.7 + 2.0*0.3 = 1.3
    expect(calibrateEstimate(1.0, 100, 200)).toBeCloseTo(1.3)
  })

  it('clamps extreme observed ratios', () => {
    // observed = 10000 → clamp 4 → 0.7 + 1.2 = 1.9
    expect(calibrateEstimate(1.0, 1, 10000)).toBeCloseTo(1.9)
    // observed = 0.0001 → clamp 0.25 → 0.7 + 0.075 = 0.775
    expect(calibrateEstimate(1.0, 10000, 1)).toBeCloseTo(0.775)
  })

  it('converges toward the true ratio over repeated calls', () => {
    let factor = 1.0
    for (let i = 0; i < 50; i++) {
      factor = calibrateEstimate(factor, 100, 150) // true ratio 1.5
    }
    expect(factor).toBeCloseTo(1.5, 1)
  })
})

describe('estimateBudget factor', () => {
  it('scales the raw estimate by the calibration factor', () => {
    const msgs = [makeMessage('hello world!')] // 12 chars / 4 = 3 tokens
    expect(estimateBudget(msgs)).toBe(3)
    expect(estimateBudget(msgs, 2.0)).toBe(6)
  })
})
