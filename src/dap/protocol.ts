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
  /** 发请求，等对应 seq 的 response；失败 response reject。
   *  timeoutMs ≤ 0 表示不限时；缺省取 DEFAULT_REQUEST_TIMEOUT_MS。 */
  request: (command: string, args?: unknown, timeoutMs?: number) => Promise<unknown>
  /** 发事件通知（不等响应）。 */
  notify: (command: string, args?: unknown) => void
  /** 订阅 event，返回取消订阅函数。 */
  on: (event: string, handler: (body: unknown) => void) => () => void
  dispose: () => void
}

/** 单请求默认超时：适配器进程存活但不响应（自身挂起、不支持的命令被静默忽略）时
 *  拒绝而非永久挂起——debug_* 工具（ToolDef 无 timeout）与 start() 的 launch 都会
 *  无限等待，整个 agent run 只能靠用户手动中止。与 MCP 客户端的单请求超时同型。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

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

/** 单帧 body 上限（字节）：Content-Length 是未受信输入——恶意/损坏适配器
 *  声明巨大 body 时 `buffer.length < bodyStart + len` 恒成立，缓冲无限增长
 *  且吞掉后续所有合法帧。超限声明视为协议错误，丢弃头部重新同步。 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024

function createFramer(): Framer {
  let buffer = Buffer.alloc(0)
  const handlers: ((json: string) => void)[] = []

  function tryParse(): void {
    // 缓冲硬上限：流中长时间无有效分帧头（垃圾字节流）时防无界增长。
    // 保留尾部 4KB 作为重新同步窗口，其余丢弃。
    if (buffer.length > MAX_FRAME_BYTES) {
      buffer = buffer.subarray(buffer.length - 4096)
    }
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
    // 超限/异常声明：丢弃该头重试，绝不为未受信长度无界缓冲
    if (!Number.isSafeInteger(len) || len < 0 || len > MAX_FRAME_BYTES) {
      buffer = buffer.subarray(sep + 4)
      if (buffer.length > 0) tryParse()
      return
    }
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
  const pending = new Map<
    number,
    {
      resolve: (b: unknown) => void
      reject: (e: Error) => void
      timer?: ReturnType<typeof setTimeout>
    }
  >()
  const eventHandlers = new Map<string, Set<(body: unknown) => void>>()
  const framer = createFramer()
  let disposed = false

  /** 终结一个 pending：清定时器 → 出表 → settle（幂等：超时/响应/关闭谁先到谁生效）。 */
  const settle = (
    id: number,
    fn: (p: { resolve: (b: unknown) => void; reject: (e: Error) => void }) => void,
  ): void => {
    const p = pending.get(id)
    if (!p) return
    if (p.timer) clearTimeout(p.timer)
    pending.delete(id)
    fn(p)
  }

  framer.onMessage((json) => {
    let msg: DAPMessage
    try {
      msg = JSON.parse(json) as DAPMessage
    } catch {
      return
    }
    if (msg.type === 'response') {
      const requestSeq = msg.request_seq ?? -1
      if (!pending.has(requestSeq)) return
      settle(requestSeq, (p) => {
        if (msg.success === false) {
          p.reject(new Error(msg.message || `DAP request ${requestSeq} failed`))
        } else {
          p.resolve(msg.body)
        }
      })
    } else if (msg.type === 'event') {
      const handlers = eventHandlers.get(msg.event ?? '')
      if (handlers) for (const h of handlers) h(msg.body)
    }
  })

  transport.onData((chunk) => framer.feed(chunk))
  transport.onClose(() => {
    disposed = true
    for (const id of Array.from(pending.keys())) {
      settle(id, (p) => p.reject(new Error('DAP transport closed')))
    }
  })

  function send(msg: DAPMessage): void {
    transport.write(encodeMessage(JSON.stringify(msg)))
  }

  return {
    request(command, args, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
      if (disposed) return Promise.reject(new Error('DAP client disposed'))
      seq += 1
      const cur = seq
      return new Promise((resolve, reject) => {
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                settle(cur, (p) =>
                  p.reject(new Error(`DAP request "${command}" timed out after ${timeoutMs}ms`)),
                )
              }, timeoutMs)
            : undefined
        pending.set(cur, { resolve, reject, ...(timer ? { timer } : {}) })
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
      for (const id of Array.from(pending.keys())) {
        settle(id, (p) => p.reject(new Error('DAP client disposed')))
      }
    },
  }
}

export type { DAPClient, DAPMessage, DAPTransport }
export { createDAPClient, createFramer, DEFAULT_REQUEST_TIMEOUT_MS, encodeMessage }
