import { afterEach, describe, expect, it, vi } from 'vitest'
import { consumeSSEBuffer, parseSSEFrame, sendChatMessage } from '@/services/chat.js'

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
  it('解析 CRLF 帧（spec 允许 CRLF 行结束）', () => {
    const buf = 'data: {"_tag":"text_delta","text":"a"}\r\n\r\ndata: {"_tag":"done"}\r\n\r\n'
    const { events, rest } = consumeSSEBuffer(buf)
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ _tag: 'text_delta', text: 'a' })
    expect(events[1]?._tag).toBe('done')
    expect(rest).toBe('')
  })

  it('跨 chunk 的 CRLF 帧（\\r 与 \\n 分属两个 chunk）', () => {
    const r1 = consumeSSEBuffer('data: {"_tag":"text_delta","te')
    expect(r1.events).toHaveLength(0)
    const r2 = consumeSSEBuffer(`${r1.rest}xt":"ok"}\r\n\r\n`)
    expect(r2.events).toHaveLength(1)
    expect(r2.events[0]).toEqual({ _tag: 'text_delta', text: 'ok' })
    expect(r2.rest).toBe('')
  })

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

  // 复现：流结束时最后一条事件无尾随空行（服务器发完直接关流）——
  // 此前该帧滞留 rest 被丢弃：done 事件丢失 → 前端把正常结束误判为
  // 「连接中断」，显示错误的中断横幅。
  it('flush 模式：无尾空行的最后一帧被解析为事件', () => {
    const buf = 'data: {"_tag":"done"}'
    const { events, rest } = consumeSSEBuffer(buf, true)
    expect(events).toHaveLength(1)
    expect(events[0]?._tag).toBe('done')
    expect(rest).toBe('')
  })

  it('flush 模式：非完整帧（截断的 JSON）不产生事件', () => {
    const buf = 'data: {"_tag":"text_delta","te'
    const { events, rest } = consumeSSEBuffer(buf, true)
    expect(events).toHaveLength(0)
    expect(rest).toBe('')
  })
})

describe('sendChatMessage SSE 流', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function chatSSEResponse(chunks: string[]): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    return new Response(body, { status: 200 })
  }

  it('末尾事件无尾空行仍被投递，doneReceived=true（不再误报中断）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        chatSSEResponse(['data: {"_tag":"text_delta","text":"hi"}\n\n', 'data: {"_tag":"done"}']),
      ),
    )
    const events: Array<{ _tag: string }> = []
    const result = await sendChatMessage('s1', 'hello', (e) => events.push(e))
    expect(result.done).toBe(true)
    expect(events.map((e) => e._tag)).toEqual(['text_delta', 'done'])
  })

  it('末尾事件带尾空行（规范流）行为不变', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chatSSEResponse(['data: {"_tag":"done"}\n\n'])),
    )
    const events: Array<{ _tag: string }> = []
    const result = await sendChatMessage('s1', 'hello', (e) => events.push(e))
    expect(result.done).toBe(true)
    expect(events.map((e) => e._tag)).toEqual(['done'])
  })
})
