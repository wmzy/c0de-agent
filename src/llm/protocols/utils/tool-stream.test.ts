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

  // 回归：身份字段（id/name）迟到的 provider——首个 delta 只带 index 与 arguments
  // 片段，id/name 在后续 delta 才到达。此前无 id/name 的 delta 被整体丢弃：
  // 领先的 arguments 片段静默蒸发，工具入参被截断/损坏（JSON 解析失败或语义漂移）。
  // 正确语义：先缓冲片段（不发事件），身份到达后补发 tool-input-start +
  // 已缓冲的 tool-input-delta，再追加当前片段——参数完整且事件顺序不变。
  it('buffers argument fragments until id/name arrive, then flushes in order', () => {
    // 首个 delta：id 有、name 缺失（身份未齐）→ 缓冲，不发任何事件
    const first = appendOrStart(empty(), { index: 0, id: 'call-1', argumentsDelta: '{"a":' })
    expect(first.events).toHaveLength(0)
    expect(first.state[0]?.input).toBe('{"a":')
    expect(first.state[0]?.started).toBe(false)

    // 第二个 delta：name 到达 → 补发 start + 已缓冲片段 + 当前片段
    const second = appendOrStart(first.state, {
      index: 0,
      id: 'call-1',
      name: 'read_file',
      argumentsDelta: '1}',
    })
    expect(second.events).toEqual([
      { type: 'tool-input-start', id: 'call-1', name: 'read_file' },
      { type: 'tool-input-delta', id: 'call-1', name: 'read_file', text: '{"a":' },
      { type: 'tool-input-delta', id: 'call-1', name: 'read_file', text: '1}' },
    ])
    expect(second.state[0]?.input).toBe('{"a":1}')
    expect(second.state[0]?.started).toBe(true)

    const fin = finishAll(second.state)
    expect(fin.tools).toEqual([{ id: 'call-1', name: 'read_file', input: { a: 1 } }])
  })

  it('keeps placeholder without events when identity never arrives', () => {
    // 完全缺失/空 id 或 name：不抛错、不发事件；state 里是未开始的占位条目，
    // finishAll 跳过（无法映射为工具调用，与旧的「整体丢弃」等价）。
    const missing = appendOrStart(empty(), { index: 0 })
    expect(missing.events).toHaveLength(0)
    expect(missing.state).toEqual({ 0: { id: '', name: '', input: '', started: false } })

    const emptyId = appendOrStart(empty(), { index: 0, id: '', name: '' })
    expect(emptyId.events).toHaveLength(0)
    expect(emptyId.state[0]?.started).toBe(false)

    // 只有 arguments 无身份的片段同样只缓冲不发射；finishAll 静默跳过
    const frag = appendOrStart(empty(), { index: 0, argumentsDelta: '{"x":1}' })
    expect(frag.events).toHaveLength(0)
    expect(frag.state[0]?.input).toBe('{"x":1}')
    const fin = finishAll(frag.state)
    expect(fin.events).toHaveLength(0)
    expect(fin.tools).toHaveLength(0)
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
