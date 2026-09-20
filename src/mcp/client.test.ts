import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMCPClient } from './client.js'
import type { MCPTransport } from './transport.js'
import type { JSONRPCRequest, MCPIncoming } from './types.js'

function makeFakeTransport() {
  const handlers: Array<(msg: MCPIncoming) => void> = []
  const closeHandlers: Array<() => void> = []
  const sent: JSONRPCRequest[] = []
  const transport = {
    send: (msg: JSONRPCRequest) => {
      sent.push(msg)
    },
    onMessage: (h: (msg: MCPIncoming) => void) => {
      handlers.push(h)
    },
    onClose: (h: () => void) => {
      closeHandlers.push(h)
    },
    close: vi.fn(),
  } as MCPTransport
  return {
    transport,
    sent,
    emit: (msg: MCPIncoming) => {
      for (const h of handlers) h(msg)
    },
    emitClose: () => {
      for (const h of closeHandlers) h()
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createMCPClient', () => {
  it('sends requests with sequential ids and resolves the matching result', async () => {
    const fake = makeFakeTransport()
    const client = createMCPClient(fake.transport)

    const p1 = client.request('initialize', { protocolVersion: '2025-03-26' })
    const p2 = client.request('tools/list')
    expect(fake.sent).toHaveLength(2)
    expect(fake.sent[0]?.id).not.toBe(fake.sent[1]?.id)
    expect(fake.sent[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    })

    // 乱序响应也要按 id 配对
    fake.emit({ jsonrpc: '2.0', id: fake.sent[1]?.id ?? 0, result: { tools: [] } })
    fake.emit({
      jsonrpc: '2.0',
      id: fake.sent[0]?.id ?? 0,
      result: { protocolVersion: '2025-03-26' },
    })

    await expect(p1).resolves.toEqual({ protocolVersion: '2025-03-26' })
    await expect(p2).resolves.toEqual({ tools: [] })
  })

  it('rejects when the server responds with a JSON-RPC error', async () => {
    const fake = makeFakeTransport()
    const client = createMCPClient(fake.transport)
    const p = client.request('tools/call', { name: 'x' })
    fake.emit({
      jsonrpc: '2.0',
      id: fake.sent[0]?.id ?? 0,
      error: { code: -32602, message: 'Invalid params', data: { detail: 'x' } },
    })
    await expect(p).rejects.toThrow(/Invalid params \(code -32602/)
  })

  it('rejects a request that exceeds the timeout', async () => {
    vi.useFakeTimers()
    const fake = makeFakeTransport()
    const client = createMCPClient(fake.transport)
    const p = client.request('tools/list', undefined, 1000)
    const assertion = expect(p).rejects.toThrow(/timed out after 1000ms/)
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    // 超时后的迟到响应不抛未处理错误
    fake.emit({ jsonrpc: '2.0', id: fake.sent[0]?.id ?? 0, result: {} })
  })

  it('sends notifications without an id', () => {
    const fake = makeFakeTransport()
    const client = createMCPClient(fake.transport)
    client.notify('notifications/initialized')
    expect(fake.sent[0]).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' })
  })

  it('rejects all pending requests when the transport closes', async () => {
    const fake = makeFakeTransport()
    const client = createMCPClient(fake.transport)
    const p = client.request('tools/list')
    fake.emitClose()
    await expect(p).rejects.toThrow(/transport closed/)
  })

  it('close() rejects pending and closes the transport', async () => {
    const fake = makeFakeTransport()
    const client = createMCPClient(fake.transport)
    const p = client.request('tools/list')
    client.close()
    await expect(p).rejects.toThrow(/client closed/)
    expect(fake.transport.close).toHaveBeenCalled()
  })
})
