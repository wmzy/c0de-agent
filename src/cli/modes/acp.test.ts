import { describe, expect, it } from 'vitest'
import {
  formatACPError,
  formatACPEvent,
  formatACPResponse,
  parseACPRequest,
  runAcpLoop,
} from './acp.js'

describe('parseACPRequest', () => {
  it('parses valid request', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'chat',
      params: { message: 'hi' },
    })
    const req = parseACPRequest(line)
    expect(req?.method).toBe('chat')
    expect(req?.id).toBe(1)
  })

  it('returns null on invalid json', () => {
    expect(parseACPRequest('not json')).toBeNull()
  })

  it('returns null when missing method', () => {
    expect(parseACPRequest(JSON.stringify({ jsonrpc: '2.0', id: 1 }))).toBeNull()
  })
})

describe('formatters', () => {
  it('formatACPResponse', () => {
    const line = formatACPResponse(1, { text: 'ok' })
    expect(JSON.parse(line)).toEqual({ jsonrpc: '2.0', id: 1, result: { text: 'ok' } })
  })

  it('formatACPError', () => {
    const line = formatACPError(1, -32601, 'no method')
    expect(JSON.parse(line)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'no method' },
    })
  })

  it('formatACPEvent (notification, no id)', () => {
    const line = formatACPEvent('event', { _tag: 'text_delta', text: 'x' })
    const parsed = JSON.parse(line)
    expect(parsed.id).toBeUndefined()
    expect(parsed.method).toBe('event')
  })
})

describe('runAcpLoop', () => {
  it('responds to session/create and echoes unknown method as error', async () => {
    const written: string[] = []
    async function* reader() {
      yield JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/create',
        params: { title: 't' },
      })
      yield JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'bogus', params: {} })
    }
    await runAcpLoop({
      reader: reader(),
      writer: (s) => written.push(s),
      handlers: {
        'session/create': async () => ({ sessionId: 's1' }),
      },
    })
    const responses = written.map((l) => JSON.parse(l))
    expect(responses[0].result.sessionId).toBe('s1')
    expect(responses[1].error).toBeDefined()
  })

  it('P2-4：chat 单飞后台执行——abort 请求不被阻塞，可中止在途 chat', async () => {
    const written: string[] = []
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    async function* reader() {
      // chat 先到：handler 阻塞在 gate 上
      yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chat', params: { message: 'x' } })
      // abort 后到：必须在 chat 完成前被处理（此前串行 await 会让它排队到最后）
      yield JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'abort', params: {} })
    }
    let aborted = false
    await runAcpLoop({
      reader: reader(),
      writer: (s) => written.push(s),
      handlers: {
        chat: async () => {
          await gate
          return { text: 'done' }
        },
        abort: async () => {
          // 模拟真实场景：abort 使在途 chat 结束
          aborted = true
          release?.()
          return { ok: true }
        },
      },
    })
    // abort 在 chat 完成前被执行——证明 loop 未被串行 await 阻塞
    expect(aborted).toBe(true)
    const responses = written.map((l) => JSON.parse(l))
    const byId = new Map<number, { result?: unknown; error?: unknown }>(
      responses.map((r) => [r.id, r]),
    )
    expect(byId.get(2)?.result).toEqual({ ok: true })
    expect(byId.get(1)?.result).toEqual({ text: 'done' })
  })
})
