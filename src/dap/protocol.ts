// DAP 协议层（spec §21）：JSON-RPC over Content-Length 分帧。
// 零外部依赖；transport 抽象分离 IO，协议层（编码/分帧/seq 配对）纯逻辑可测。

/** DAP 传输抽象：包装适配器进程的 stdin/stdout。真实实现见 transport.ts。 */
type DAPTransport = {
  write: (chunk: string | Uint8Array) => void
  onData: (handler: (chunk: Uint8Array | string) => void) => void
  onClose: (handler: () => void) => void
  close: () => void
}

type DAPMessage = {
  seq: number
  type: 'request' | 'response' | 'event'
  command?: string
  event?: string
  arguments?: unknown
  success?: boolean
  message?: string
  body?: unknown
  request_seq?: number
}

/** DAP 客户端：发 request 等 response，收 event。 */
type DAPClient = {
  /** 发请求，等对应 seq 的 response；失败 response reject。 */
  request: (command: string, args?: unknown) => Promise<unknown>
  /** 发事件通知（不等响应）。 */
  notify: (command: string, args?: unknown) => void
  /** 订阅 event，返回取消订阅函数。 */
  on: (event: string, handler: (body: unknown) => void) => () => void
  dispose: () => void
}

/** 把一条 JSON 消息编码为 DAP 分帧字节（`Content-Length: N\r\n\r\n{json}`）。 */
function encodeMessage(json: string): string {
  const len = Buffer.byteLength(json, 'utf8')
  return `Content-Length: ${len}\r\n\r\n${json}`
}

/** 输入流分帧器：喂字节，吐完整 JSON 消息。处理跨 chunk / 粘包。 */
type Framer = {
  feed: (chunk: Uint8Array | string) => void
  onMessage: (handler: (json: string) => void) => void
}

function createFramer(): Framer {
  let buffer = Buffer.alloc(0)
  const handlers: ((json: string) => void)[] = []

  function tryParse(): void {
    // 找 header 结束分隔符 \r\n\r\n
    const sep = buffer.indexOf('\r\n\r\n')
    if (sep === -1) return
    const header = buffer.subarray(0, sep).toString('utf8')
    const m = /Content-Length:\s*(\d+)/i.exec(header)
    if (!m) {
      // 协议错误：丢弃分隔符前内容重试
      buffer = buffer.subarray(sep + 4)
      if (buffer.length > 0) tryParse()
      return
    }
    const len = Number(m[1])
    const bodyStart = sep + 4
    if (buffer.length < bodyStart + len) return // body 未到齐
    const body = buffer.subarray(bodyStart, bodyStart + len).toString('utf8')
    buffer = buffer.subarray(bodyStart + len)
    for (const h of handlers) h(body)
    if (buffer.length > 0) tryParse() // 粘包：继续解析
  }

  return {
    feed(chunk) {
      buffer =
        typeof chunk === 'string'
          ? Buffer.concat([buffer, Buffer.from(chunk, 'utf8')])
          : Buffer.concat([buffer, chunk])
      tryParse()
    },
    onMessage(handler) {
      handlers.push(handler)
    },
  }
}

/** 创建 DAP 客户端。transport 由调用方提供（真实为适配器进程 stdio）。 */
function createDAPClient(transport: DAPTransport): DAPClient {
  let seq = 0
  const pending = new Map<number, { resolve: (b: unknown) => void; reject: (e: Error) => void }>()
  const eventHandlers = new Map<string, Set<(body: unknown) => void>>()
  const framer = createFramer()
  let disposed = false

  framer.onMessage((json) => {
    let msg: DAPMessage
    try {
      msg = JSON.parse(json) as DAPMessage
    } catch {
      return
    }
    if (msg.type === 'response') {
      const p = pending.get(msg.request_seq ?? -1)
      if (!p) return
      pending.delete(msg.request_seq ?? -1)
      if (msg.success === false) {
        p.reject(new Error(msg.message || `DAP request ${msg.request_seq} failed`))
      } else {
        p.resolve(msg.body)
      }
    } else if (msg.type === 'event') {
      const handlers = eventHandlers.get(msg.event ?? '')
      if (handlers) for (const h of handlers) h(msg.body)
    }
  })

  transport.onData((chunk) => framer.feed(chunk))
  transport.onClose(() => {
    disposed = true
    for (const p of pending.values()) p.reject(new Error('DAP transport closed'))
    pending.clear()
  })

  function send(msg: DAPMessage): void {
    transport.write(encodeMessage(JSON.stringify(msg)))
  }

  return {
    request(command, args) {
      if (disposed) return Promise.reject(new Error('DAP client disposed'))
      seq += 1
      const cur = seq
      return new Promise((resolve, reject) => {
        pending.set(cur, { resolve, reject })
        send({ seq: cur, type: 'request', command, arguments: args })
      })
    },
    notify(command, args) {
      if (disposed) return
      seq += 1
      send({ seq, type: 'request', command, arguments: args })
    },
    on(event, handler) {
      let set = eventHandlers.get(event)
      if (!set) {
        set = new Set()
        eventHandlers.set(event, set)
      }
      set.add(handler)
      return () => {
        set?.delete(handler)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      transport.close()
      for (const p of pending.values()) p.reject(new Error('DAP client disposed'))
      pending.clear()
    },
  }
}

export type { DAPClient, DAPMessage, DAPTransport }
export { createDAPClient, createFramer, encodeMessage }
