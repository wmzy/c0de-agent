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
})
