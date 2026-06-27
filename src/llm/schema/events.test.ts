import { describe, expect, it } from 'vitest'
import type { StreamEvent, ToolCallEvent } from './events.js'
import {
  foldResponse,
  responseReasoning,
  responseText,
  responseToolCalls,
  usageFrom,
  visibleOutputTokens,
} from './events.js'

describe('schema/events Usage', () => {
  it('falls back to input+output for totalTokens', () => {
    const u = usageFrom({ inputTokens: 100, outputTokens: 50 })
    expect(u.totalTokens).toBe(150)
  })

  it('keeps provider-reported total when present', () => {
    const u = usageFrom({ inputTokens: 10, outputTokens: 5, totalTokens: 999 })
    expect(u.totalTokens).toBe(999)
  })

  it('visibleOutputTokens subtracts reasoning from output', () => {
    expect(visibleOutputTokens(usageFrom({ outputTokens: 100, reasoningTokens: 30 }))).toBe(70)
  })

  it('visibleOutputTokens never goes negative', () => {
    expect(visibleOutputTokens(usageFrom({ outputTokens: 10, reasoningTokens: 99 }))).toBe(0)
  })
})

describe('schema/events foldResponse', () => {
  it('folds text deltas into LLMResponse', () => {
    const events: StreamEvent[] = [
      { type: 'text-delta', id: 'b1', text: 'hel' },
      { type: 'text-delta', id: 'b1', text: 'lo' },
      { type: 'finish', reason: 'stop', usage: usageFrom({ inputTokens: 1, outputTokens: 2 }) },
    ]
    const res = foldResponse(events)
    expect(responseText(res)).toBe('hello')
    expect(res.usage?.totalTokens).toBe(3)
  })

  it('collects tool-call events', () => {
    const tc: ToolCallEvent = { type: 'tool-call', id: 't1', name: 'echo', input: { x: 1 } }
    const res = foldResponse([tc])
    expect(responseToolCalls(res)).toEqual([tc])
  })

  it('folds reasoning deltas', () => {
    const events: StreamEvent[] = [
      { type: 'reasoning-delta', id: 'r1', text: 'think' },
      { type: 'reasoning-delta', id: 'r1', text: 'ing' },
    ]
    expect(responseReasoning(foldResponse(events))).toBe('thinking')
  })
})
