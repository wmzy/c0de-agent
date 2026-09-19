type ACPRequest = {
  id: number | string | null
  method: string
  params: Record<string, unknown>
}

type ACPHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>

type AcpLoopOptions = {
  reader: AsyncGenerator<string>
  writer: (line: string) => void
  handlers: Record<string, ACPHandler>
}

function parseACPRequest(line: string): ACPRequest | null {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (obj === null || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (typeof o.method !== 'string') return null
  return {
    id: (o.id ?? null) as number | string | null,
    method: o.method,
    params: (o.params ?? {}) as Record<string, unknown>,
  }
}

function formatACPResponse(id: number | string | null, result: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function formatACPError(id: number | string | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

function formatACPEvent(method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params })
}

async function runAcpLoop(opts: AcpLoopOptions): Promise<void> {
  // P2-4：chat 在后台单飞执行——loop 继续读取后续请求（abort 等）而不被阻塞。
  // 此前串行 await 使 abort 请求永远排在 chat 完成之后，中止形同虚设。
  let chatInFlight: Promise<void> | null = null
  const writer = opts.writer
  for await (const line of opts.reader) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const req = parseACPRequest(trimmed)
    if (!req) {
      writer(formatACPError(null, -32700, 'Parse error'))
      continue
    }
    const handler = opts.handlers[req.method]
    if (!handler) {
      if (req.id !== null) writer(formatACPError(req.id, -32601, `Method not found: ${req.method}`))
      continue
    }
    const respond = (result: Record<string, unknown>): void => {
      if (req.id !== null) writer(formatACPResponse(req.id, result))
    }
    const fail = (err: unknown): void => {
      if (req.id !== null) {
        writer(formatACPError(req.id, -32603, err instanceof Error ? err.message : String(err)))
      }
    }
    if (req.method === 'chat') {
      if (chatInFlight) {
        fail(new Error('chat: another chat is already in progress (abort it first)'))
        continue
      }
      chatInFlight = (async () => {
        try {
          respond(await handler(req.params))
        } catch (err) {
          fail(err)
        } finally {
          chatInFlight = null
        }
      })()
      void chatInFlight
      continue
    }
    try {
      respond(await handler(req.params))
    } catch (err) {
      fail(err)
    }
  }
  // 流结束前等最后一个在途 chat 收尾，保证响应写全。
  if (chatInFlight) await chatInFlight
}

export type { ACPHandler, ACPRequest, AcpLoopOptions }
export { formatACPError, formatACPEvent, formatACPResponse, parseACPRequest, runAcpLoop }
