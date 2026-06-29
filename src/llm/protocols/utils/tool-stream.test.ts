import { describe, expect, it } from 'vitest'
import { isLLMError } from '../../schema/errors.js'
import { appendOrStart, empty, finishAll, parseToolInput } from './tool-stream.js'

describe('tool-stream appendOrStart', () => {
  it('starts a tool on first delta and emits start + delta', () => {
    const { state, events } = appendOrStart(empty(), {
      index: 0,
      id: 't1',
      name: 'echo',
      argumentsDelta: '{"x":',
    })
    expect(events).toEqual([
      { type: 'tool-input-start', id: 't1', name: 'echo' },
      { type: 'tool-input-delta', id: 't1', name: 'echo', text: '{"x":' },
    ])
    expect(state[0]?.input).toBe('{"x":')
  })

  it('appends to an existing tool without re-starting', () => {
    const started = appendOrStart(empty(), { index: 0, id: 't1', name: 'echo' })
    const { state, events } = appendOrStart(started.state, { index: 0, argumentsDelta: '1}' })
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('tool-input-delta')
    expect(state[0]?.input).toBe('1}')
  })

  it('drops delta when id or name is missing or empty', () => {
    // 缺失 id/name：丢弃该 delta（不抛错、不创建 tool），state 不变。
    // 部分兼容 provider 把 arguments 片段拆成多个 delta，每片 id/name 为空。
    const missing = appendOrStart(empty(), { index: 0 })
    expect(missing.events).toHaveLength(0)
    expect(missing.state).toEqual({})

    // 空字符串 id/name：同样丢弃（不与 undefined 区分）
    const emptyId = appendOrStart(empty(), { index: 0, id: '', name: '' })
    expect(emptyId.events).toHaveLength(0)
    expect(emptyId.state).toEqual({})
  })

  it('does not emit delta for empty argument fragments', () => {
    const { state, events } = appendOrStart(empty(), {
      index: 0,
      id: 't1',
      name: 'echo',
      argumentsDelta: '',
    })
    expect(events).toEqual([{ type: 'tool-input-start', id: 't1', name: 'echo' }])
    expect(state[0]?.input).toBe('')
  })
})

describe('tool-stream finishAll', () => {
  it('parses and emits tool-call events', () => {
    const { state } = appendOrStart(empty(), { index: 0, id: 't1', name: 'echo' })
    const { events, tools } = finishAll(
      appendOrStart(state, { index: 0, argumentsDelta: '{"a":1}' }).state,
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

  it('marks unparseable input with _parseError instead of throwing (truncated stream)', () => {
    // 模型流被截断，arguments 只收到半截 JSON —— finishAll 不应抛错中断流。
    const started = appendOrStart(empty(), {
      index: 0,
      id: 't1',
      name: 'grep',
      argumentsDelta: '{"pattern": "',
    })
    const { events, tools } = finishAll(started.state)
    expect(tools[0]?.input).toEqual({
      _parseError: expect.any(String),
      _raw: '{"pattern": "',
    })
    // 回归：_parseError 必须是可读消息。parseToolInput 抛的是 llmError（普通对象），
    // 旧实现用 String(e) 会退化成 "[object Object]"，最终渲染为
    // "_parseError: [object Object]"。
    const parseErr =
      tools[0]?.input && typeof tools[0].input === 'object' && '_parseError' in tools[0].input
        ? (tools[0].input as { _parseError: string })._parseError
        : ''
    expect(parseErr).not.toBe('[object Object]')
    expect(parseErr.length).toBeGreaterThan(0)
    // 仍正常发出 tool-call / tool-input-end，让流完整结束
    expect(events.some((e) => e.type === 'tool-call')).toBe(true)
    expect(events.some((e) => e.type === 'tool-input-end')).toBe(true)
  })
})
