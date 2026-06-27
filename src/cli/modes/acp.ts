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
  for await (const line of opts.reader) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const req = parseACPRequest(trimmed)
    if (!req) {
      opts.writer(formatACPError(null, -32700, 'Parse error'))
      continue
    }
    const handler = opts.handlers[req.method]
    if (!handler) {
      if (req.id !== null)
        opts.writer(formatACPError(req.id, -32601, `Method not found: ${req.method}`))
      continue
    }
    try {
      const result = await handler(req.params)
      if (req.id !== null) opts.writer(formatACPResponse(req.id, result))
    } catch (err) {
      if (req.id !== null) {
        opts.writer(
          formatACPError(req.id, -32603, err instanceof Error ? err.message : String(err)),
        )
      }
    }
  }
}

export type { ACPHandler, ACPRequest, AcpLoopOptions }
export { formatACPError, formatACPEvent, formatACPResponse, parseACPRequest, runAcpLoop }
