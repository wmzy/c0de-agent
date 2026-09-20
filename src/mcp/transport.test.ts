import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createHttpTransport, createStdioTransport, parseSSEStream } from './transport.js'
import type { MCPIncoming } from './types.js'

/** 假子进程：EventEmitter + 可写 stdin + unref/kill。 */
function makeFakeChild() {
  const stdin = { destroyed: false, write: vi.fn() }
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  let killed = false
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill() {
      killed = true
      stdout.emit('close')
    },
    unref: vi.fn(),
  }) as unknown as ChildProcessWithoutNullStreams
  return {
    child,
    stdin,
    stdout,
    stderr,
    isKilled: () => killed,
  }
}

describe('createStdioTransport', () => {
  it('parses newline-delimited JSON across chunks and handles 粘包', () => {
    const { child, stdout } = makeFakeChild()
    const transport = createStdioTransport('node', ['x'], () => child)
    const got: MCPIncoming[] = []
    transport.onMessage((m) => got.push(m))

    stdout.emit('data', '{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":')
    stdout.emit('data', '"2.0","method":"b"}\n')
    stdout.emit('data', 'some log line\n')

    expect(got).toHaveLength(2)
    expect(got[0]).toMatchObject({ jsonrpc: '2.0', method: 'a' })
    expect(got[1]).toMatchObject({ jsonrpc: '2.0', method: 'b' })
  })

  it('writes JSON + newline to stdin and kills child on close', () => {
    const { child, stdin, isKilled } = makeFakeChild()
    const transport = createStdioTransport('node', ['x'], () => child)
    transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(stdin.write).toHaveBeenCalledWith('{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
    transport.close()
    expect(isKilled()).toBe(true)
  })

  it('unrefs the child so the parent process can exit', () => {
    const { child } = makeFakeChild()
    createStdioTransport('node', [], () => child)
    expect(child.unref).toHaveBeenCalled()
  })
})

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('createHttpTransport', () => {
  it('posts JSON and routes the JSON response to handlers', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const transport = createHttpTransport('http://x/mcp', { fetchFn })
    const got: MCPIncoming[] = []
    transport.onMessage((m) => got.push(m))
    transport.send({ jsonrpc: '2.0', id: 7, method: 'ping' })
    await vi.waitFor(() => expect(got).toHaveLength(1))
    expect(got[0]).toMatchObject({ id: 7, result: { ok: true } })
  })

  it('emits an error response when the server returns a non-ok status', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 404 }))
    const transport = createHttpTransport('http://x/mcp', { fetchFn })
    const got: MCPIncoming[] = []
    transport.onMessage((m) => got.push(m))
    transport.send({ jsonrpc: '2.0', id: 3, method: 'ping' })
    await vi.waitFor(() => expect(got).toHaveLength(1))
    expect(got[0]).toMatchObject({ id: 3, error: { code: -32000 } })
  })

  it('parses streamable SSE responses, including split events', async () => {
    const fetchFn = vi.fn(async (_input: string, init: RequestInit) => {
      const id = (JSON.parse(String(init.body)) as { id: number }).id
      const result = id === 1 ? '{"a":1}' : '{"b":2}'
      // 每个请求只回自己的响应，且 data 跨 chunk 切分
      return sseResponse([`data: {"jsonrpc":"2.0","id":${id},"resul`, `t":${result}}\n\n`])
    })
    const transport = createHttpTransport('http://x/mcp', { sse: true, fetchFn })
    const got: MCPIncoming[] = []
    transport.onMessage((m) => got.push(m))
    transport.send({ jsonrpc: '2.0', id: 1, method: 'a' })
    transport.send({ jsonrpc: '2.0', id: 2, method: 'b' })
    await vi.waitFor(() => expect(got).toHaveLength(2))
    expect(got[0]).toMatchObject({ id: 1, result: { a: 1 } })
    expect(got[1]).toMatchObject({ id: 2, result: { b: 2 } })
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({
      accept: 'text/event-stream',
    })
  })

  it('emits an error response when the request itself fails', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const transport = createHttpTransport('http://x/mcp', { fetchFn })
    const got: MCPIncoming[] = []
    transport.onMessage((m) => got.push(m))
    transport.send({ jsonrpc: '2.0', id: 5, method: 'ping' })
    await vi.waitFor(() => expect(got).toHaveLength(1))
    expect(got[0]).toMatchObject({ id: 5, error: { message: 'ECONNREFUSED' } })
  })
})

describe('parseSSEStream', () => {
  it('emits data payloads as events arrive', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message\ndata: {"x":1}\n\n'))
        controller.enqueue(encoder.encode('data: {"x":2}\n\n'))
        controller.close()
      },
    })
    const events: string[] = []
    await parseSSEStream(
      body,
      (d) => events.push(d),
      () => false,
    )
    expect(events).toEqual(['{"x":1}', '{"x":2}'])
  })
})
