import { describe, expect, it, vi } from 'vitest'
import { createDAPClient, createFramer, type DAPTransport, encodeMessage } from './protocol.js'

// 测试用内存 transport：捕获写出，可手动注入入站数据。
function memTransport() {
  const dataH: Array<(c: string | Uint8Array) => void> = []
  const closeH: Array<() => void> = []
  let closed = false
  const t: DAPTransport & {
    emit: (chunk: string | Uint8Array) => void
    written: () => string
    isClosed: () => boolean
  } = {
    write: vi.fn(),
    onData: (h) => {
      dataH.push(h)
    },
    onClose: (h) => {
      closeH.push(h)
    },
    close: () => {
      closed = true
      for (const h of closeH) h()
    },
    emit: (chunk) => {
      for (const h of dataH) h(chunk)
    },
    written: () =>
      (t.write as unknown as { mock: { calls: Array<Array<string | Uint8Array>> } }).mock.calls
        .map((c) =>
          typeof c[0] === 'string' ? c[0] : Buffer.from(c[0] as Uint8Array).toString('utf8'),
        )
        .join(''),
    isClosed: () => closed,
  }
  return t
}

describe('encodeMessage', () => {
  it('wraps json with Content-Length header', () => {
    const out = encodeMessage('{"x":1}')
    expect(out).toBe('Content-Length: 7\r\n\r\n{"x":1}')
  })

  it('uses UTF-8 byte length (multibyte)', () => {
    const out = encodeMessage('{"a":"中"}')
    // "中" is 3 bytes → total 11 bytes, not string length 9
    expect(out).toContain('Content-Length: 11\r\n\r\n')
  })
})

describe('createFramer', () => {
  it('emits a complete message', () => {
    const framer = createFramer()
    const got: string[] = []
    framer.onMessage((j) => got.push(j))
    framer.feed(encodeMessage('{"seq":1}'))
    expect(got).toEqual(['{"seq":1}'])
  })

  it('reassembles a message split across chunks', () => {
    const framer = createFramer()
    const got: string[] = []
    framer.onMessage((j) => got.push(j))
    const full = encodeMessage('{"seq":2}')
    framer.feed(full.slice(0, 10))
    framer.feed(full.slice(10))
    expect(got).toEqual(['{"seq":2}'])
  })

  it('handles back-to-back messages (packet coalescing)', () => {
    const framer = createFramer()
    const got: string[] = []
    framer.onMessage((j) => got.push(j))
    framer.feed(encodeMessage('{"a":1}') + encodeMessage('{"b":2}'))
    expect(got).toEqual(['{"a":1}', '{"b":2}'])
  })

  // 复现：Content-Length 头被无条件信任——恶意/损坏适配器声明巨大 body 时
  // `buffer.length < bodyStart + len` 恒成立，缓冲无限增长，后续合法帧被
  // 永久吞进缓冲，永远无法解析。
  it('drops a frame declaring an oversized Content-Length', () => {
    const framer = createFramer()
    const got: string[] = []
    framer.onMessage((j) => got.push(j))
    // 声明 2^62 字节 body（远超任何合法 DAP 消息）
    framer.feed('Content-Length: 4611686018427387904\r\n\r\n')
    // 后续合法帧必须仍可解析
    framer.feed(encodeMessage('{"seq":2,"type":"response"}'))
    expect(got).toEqual(['{"seq":2,"type":"response"}'])
  })
})

describe('createDAPClient', () => {
  it('sends a framed request with seq=1', () => {
    const t = memTransport()
    const client = createDAPClient(t)
    void client.request('initialize', { adapterID: 'node' })
    const w = t.written()
    expect(w).toContain('Content-Length:')
    expect(w).toContain('"command":"initialize"')
    expect(w).toContain('"seq":1')
    expect(w).toContain('"type":"request"')
  })

  it('resolves request body when matching response arrives', async () => {
    const t = memTransport()
    const client = createDAPClient(t)
    const p = client.request('stackTrace', { threadId: 1 })
    t.emit(
      encodeMessage(
        JSON.stringify({
          seq: 99,
          type: 'response',
          request_seq: 1,
          success: true,
          body: { totalFrames: 2 },
        }),
      ),
    )
    await expect(p).resolves.toEqual({ totalFrames: 2 })
  })

  it('rejects when response reports failure', async () => {
    const t = memTransport()
    const client = createDAPClient(t)
    const p = client.request('setBreakpoints', {})
    t.emit(
      encodeMessage(
        JSON.stringify({
          seq: 2,
          type: 'response',
          request_seq: 1,
          success: false,
          message: 'bad source',
        }),
      ),
    )
    await expect(p).rejects.toThrow('bad source')
  })

  it('dispatches events to on() handlers', () => {
    const t = memTransport()
    const client = createDAPClient(t)
    const handler = vi.fn()
    client.on('stopped', handler)
    t.emit(
      encodeMessage(
        JSON.stringify({
          seq: 5,
          type: 'event',
          event: 'stopped',
          body: { reason: 'breakpoint', threadId: 1 },
        }),
      ),
    )
    expect(handler).toHaveBeenCalledWith({ reason: 'breakpoint', threadId: 1 })
  })

  it('notify sends without awaiting a response', () => {
    const t = memTransport()
    const client = createDAPClient(t)
    client.notify('disconnect', { restart: false })
    const w = t.written()
    expect(w).toContain('"command":"disconnect"')
  })

  it('dispose closes transport and rejects pending requests', async () => {
    const t = memTransport()
    const client = createDAPClient(t)
    const p = client.request('evaluate', { expression: 'x' })
    client.dispose()
    expect(t.isClosed()).toBe(true)
    await expect(p).rejects.toThrow()
  })

  it('rejects new requests after dispose', async () => {
    const t = memTransport()
    const client = createDAPClient(t)
    client.dispose()
    await expect(client.request('continue', {})).rejects.toThrow('disposed')
  })

  // 复现：request 只有「响应到达」与「transport 关闭」两条终结路径——适配器进程
  // 存活但不响应（自身挂起/不支持的命令被忽略）时 promise 永不 settle：debug_*
  // 工具（无 ToolDef.timeout）与 start() 的 launch 永久挂住整个 agent run，用户
  // 只能手动中止。MCP 客户端同型已有单请求超时（DEFAULT_REQUEST_TIMEOUT_MS）。
  it('适配器不响应时按超时拒绝（不再永久挂起）', { timeout: 3000 }, async () => {
    const t = memTransport()
    const client = createDAPClient(t)
    await expect(client.request('stackTrace', { threadId: 1 }, 30)).rejects.toThrow(
      /timed out after 30ms/,
    )
  })

  it('超时前收到响应 → 正常 resolve（不误报超时）', async () => {
    const t = memTransport()
    const client = createDAPClient(t)
    const p = client.request('evaluate', { expression: '1' }, 1000)
    t.emit(
      encodeMessage(
        JSON.stringify({
          seq: 3,
          type: 'response',
          request_seq: 1,
          success: true,
          body: { result: '1' },
        }),
      ),
    )
    await expect(p).resolves.toEqual({ result: '1' })
    // 已 settle 的请求不再被后续超时/响应干扰：同一客户端继续可用
    const p2 = client.request('continue', { threadId: 1 }, 1000)
    t.emit(
      encodeMessage(
        JSON.stringify({ seq: 4, type: 'response', request_seq: 2, success: true, body: {} }),
      ),
    )
    await expect(p2).resolves.toEqual({})
  })
})
