import { describe, expect, it } from 'vitest'
import { consumeSSEBuffer, parseSSEFrame } from './chat.js'

describe('parseSSEFrame', () => {
  it('解析 data 行 JSON', () => {
    const frame = 'event: text_delta\ndata: {"_tag":"text_delta","text":"hi"}'
    expect(parseSSEFrame(frame)).toEqual({ _tag: 'text_delta', text: 'hi' })
  })

  it('多行 data 合并', () => {
    const frame = 'data: {"_tag":"text_delta",\ndata: "text":"world"}'
    expect(parseSSEFrame(frame)).toEqual({ _tag: 'text_delta', text: 'world' })
  })

  it('无 data 行返回 null', () => {
    expect(parseSSEFrame('event: ping')).toBeNull()
  })

  it('JSON 非法返回 null', () => {
    expect(parseSSEFrame('data: {bad}')).toBeNull()
  })
})

describe('consumeSSEBuffer', () => {
  it('完整帧返回事件，清空 rest', () => {
    const buf = 'data: {"_tag":"done"}\n\n'
    const { events, rest } = consumeSSEBuffer(buf)
    expect(events).toHaveLength(1)
    expect(events[0]?._tag).toBe('done')
    expect(rest).toBe('')
  })

  it('不完整帧保留在 rest', () => {
    const buf = 'data: {"_tag":"text_delta","text":"par'
    const { events, rest } = consumeSSEBuffer(buf)
    expect(events).toHaveLength(0)
    expect(rest).toBe(buf)
  })

  it('跨 chunk 重组：先部分后补全', () => {
    const part1 = 'data: {"_tag":"text_delta","te'
    const r1 = consumeSSEBuffer(part1)
    expect(r1.events).toHaveLength(0)
    const part2 = `${r1.rest}xt":"ok"}\n\n`
    const r2 = consumeSSEBuffer(part2)
    expect(r2.events).toHaveLength(1)
    expect(r2.events[0]).toEqual({ _tag: 'text_delta', text: 'ok' })
  })

  it('多帧混合', () => {
    const buf =
      'data: {"_tag":"text_delta","text":"a"}\n\ndata: {"_tag":"done"}\n\ndata: {"_tag":"text_delta","text":"b"}'
    const { events, rest } = consumeSSEBuffer(buf)
    expect(events).toHaveLength(2)
    expect(rest).toBe('data: {"_tag":"text_delta","text":"b"}')
  })
})
