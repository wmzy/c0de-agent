import { describe, expect, it } from 'vitest'
import { appendOrStart, empty, finishAll, parseToolInput } from './tool-stream.js'
import { isLLMError } from '../../schema/errors.js'

describe('tool-stream appendOrStart', () => {
  it('starts a tool on first delta and emits start + delta', () => {
    const { state, events } = appendOrStart(
      empty(),
      { index: 0, id: 't1', name: 'echo', argumentsDelta: '{"x":' },
      'missing',
    )
    expect(events).toEqual([
      { type: 'tool-input-start', id: 't1', name: 'echo' },
      { type: 'tool-input-delta', id: 't1', name: 'echo', text: '{"x":' },
    ])
    expect(state[0]?.input).toBe('{"x":')
  })

  it('appends to an existing tool without re-starting', () => {
    const started = appendOrStart(empty(), { index: 0, id: 't1', name: 'echo' }, 'm')
    const { state, events } = appendOrStart(
      started.state,
      { index: 0, argumentsDelta: '1}' },
      'missing',
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('tool-input-delta')
    expect(state[0]?.input).toBe('1}')
  })

  it('throws when starting without id or name', () => {
    expect(() => appendOrStart(empty(), { index: 0 }, 'need id')).toThrow()
  })

  it('does not emit delta for empty argument fragments', () => {
    const { state, events } = appendOrStart(
      empty(),
      { index: 0, id: 't1', name: 'echo', argumentsDelta: '' },
      'm',
    )
    expect(events).toEqual([{ type: 'tool-input-start', id: 't1', name: 'echo' }])
    expect(state[0]?.input).toBe('')
  })
})

describe('tool-stream finishAll', () => {
  it('parses and emits tool-call events', () => {
    const { state } = appendOrStart(empty(), { index: 0, id: 't1', name: 'echo' }, 'm')
    const { events, tools } = finishAll(
      appendOrStart(state, { index: 0, argumentsDelta: '{"a":1}' }, 'm').state,
    )
    expect(tools).toEqual([{ id: 't1', name: 'echo', input: { a: 1 } }])
    expect(events.some((e) => e.type === 'tool-call')).toBe(true)
    expect(events.some((e) => e.type === 'tool-input-end')).toBe(true)
  })

  it('treats empty input as {}', () => {
    expect(parseToolInput('')).toEqual({})
  })

  it('throws on invalid JSON', () => {
    expect(() => parseToolInput('{bad')).toThrow()
  })

  it('isLLMError is true for invalid tool JSON', () => {
    try {
      parseToolInput('{bad')
      throw new Error('should not reach')
    } catch (e) {
      expect(isLLMError(e)).toBe(true)
    }
  })
})
