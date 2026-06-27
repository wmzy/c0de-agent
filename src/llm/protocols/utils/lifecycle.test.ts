import { describe, expect, it } from 'vitest'
import { usageFrom } from '../../schema/events.js'
import { finish, initial, reasoningDelta, textDelta } from './lifecycle.js'

describe('lifecycle textDelta', () => {
  it('emits step-start + text-start + text-delta on first use', () => {
    const state = initial()
    const r1 = textDelta(state, [], 'b1', 'hel')
    const r2 = textDelta(r1.state, r1.events, 'b1', 'lo')
    expect(r2.events.map((e) => e.type)).toEqual([
      'step-start',
      'text-start',
      'text-delta',
      'text-delta',
    ])
  })

  it('does not emit step-start twice', () => {
    const state = initial()
    const r1 = textDelta(state, [], 'b1', 'a')
    const r2 = textDelta(r1.state, [], 'b2', 'b')
    const allEvents = [...r1.events, ...r2.events]
    expect(allEvents.filter((e) => e.type === 'step-start')).toHaveLength(1)
  })
})

describe('lifecycle reasoningDelta', () => {
  it('emits reasoning-start before reasoning-delta', () => {
    const r = reasoningDelta(initial(), [], 'r1', 'think')
    expect(r.events.map((e) => e.type)).toEqual([
      'step-start',
      'reasoning-start',
      'reasoning-delta',
    ])
  })
})

describe('lifecycle finish', () => {
  it('closes open blocks and emits step-finish + finish', () => {
    const afterText = textDelta(initial(), [], 'b1', 'hi')
    const r = finish(afterText.state, afterText.events, {
      reason: 'stop',
      usage: usageFrom({ inputTokens: 5, outputTokens: 2 }),
    })
    expect(r.events.map((e) => e.type)).toEqual([
      'step-start',
      'text-start',
      'text-delta',
      'text-end',
      'step-finish',
      'finish',
    ])
    expect(r.state.stepStarted).toBe(false)
  })

  it('finish with tool-calls reason closes reasoning blocks too', () => {
    const afterReasoning = reasoningDelta(initial(), [], 'r1', 'hmm')
    const r = finish(afterReasoning.state, afterReasoning.events, { reason: 'tool-calls' })
    expect(r.events.some((e) => e.type === 'reasoning-end')).toBe(true)
  })
})
