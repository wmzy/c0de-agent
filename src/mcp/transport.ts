// MCP 传输层（spec §6.1）：stdio（子进程 + 换行分帧 JSON）与 streamable HTTP
// （POST JSON / SSE 流式响应）两种传输。零外部依赖；IO 边界（spawn/fetch）可注入，
// 协议分帧与客户端逻辑纯逻辑可测。

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import type { JSONRPCNotification, JSONRPCRequest, JSONRPCResponse, MCPIncoming } from './types.js'

/** 底层传输抽象：发 JSON-RPC 消息、收服务端消息、关连接。 */
type MCPTransport = {
  send: (msg: JSONRPCRequest | JSONRPCNotification) => void
  onMessage: (handler: (msg: MCPIncoming) => void) => void
  onClose: (handler: () => void) => void
  close: () => void
}

/** 可注入的 spawn：返回带 stdin/stdout/stderr 流的子进程（测试注入假进程）。 */
type SpawnFn = (command: string, args: string[]) => ChildProcessWithoutNullStreams

/** 可注入的 fetch（测试注入假 Response）。 */
type FetchFn = (input: string, init: RequestInit) => Promise<Response>

/** 错误响应构造（-32000 = server error，JSON-RPC 惯例）。 */
function errorResponse(
  msg: JSONRPCRequest | JSONRPCNotification,
  message: string,
): JSONRPCResponse {
  return {
    jsonrpc: '2.0',
    id: 'id' in msg ? msg.id : 0,
    error: { code: -32000, message },
  }
}

/**
 * stdio 传输：spawn 子进程，stdout 按行解析 JSON（MCP stdio 规范：
 * 每行一条 JSON-RPC 消息，无 Content-Length 分帧）。跨 chunk / 粘包已处理。
 */

/** 单条 stdio 消息行上限（字符）：服务器持续输出不换行或单条消息超大时，
 *  `buffer += chunk` 会无限增长直至 OOM——超限整行丢弃并告警，防缓冲无界。 */
const MAX_LINE_CHARS = 32 * 1024 * 1024

function createStdioTransport(
  command: string,
  args: string[] = [],
  spawnFn: SpawnFn = spawn,
): MCPTransport {
  const child = spawnFn(command, args)
  // 子进程不参与父进程事件循环存活：父退出 → stdin 管道关闭 → 合规 MCP
  // 服务器读到 EOF 自行退出。否则长驻的 MCP 服务器会让 CLI 进程无法结束。
  child.unref()
  const handlers: Array<(msg: MCPIncoming) => void> = []
  const closeHandlers: Array<() => void> = []
  let buffer = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    // 超长行防护：无换行的持续输出或单条超限消息立即丢弃，防缓冲无界增长。
    // 丢弃不改变「完整合法行仍可解析」的语义——超限行本身本就无法作为
    // 合法 JSON-RPC 消息使用。
    const nl = buffer.indexOf('\n')
    if (buffer.length > MAX_LINE_CHARS && (nl === -1 || nl > MAX_LINE_CHARS)) {
      const drop = nl === -1 ? buffer.length : nl + 1
      console.warn(`[mcp:stdio] 丢弃超长输出 ${drop} 字符（单行超过 ${MAX_LINE_CHARS} 上限）`)
      buffer = buffer.slice(drop)
    }
    const consume = (): void => {
      const idx = buffer.indexOf('\n')
      if (idx < 0) return
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line.length > 0) {
        let msg: MCPIncoming
        try {
          msg = JSON.parse(line) as MCPIncoming
        } catch {
          consume() // 非 JSON 行（日志等）忽略，继续解析后续行
          return
        }
        for (const h of handlers) h(msg)
      }
      consume()
    }
    consume()
  })
  // 不读取 stderr 会让管道写满卡死子进程——消费并透传到父进程 stderr。
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    process.stderr.write(`[mcp:stdio] ${chunk}`)
  })
  // spawn 失败（ENOENT 等）：无监听器时 unhandled 'error' 会击穿父进程。
  // 仅记录——随后的 'close' 事件走既有关闭路径 reject pending。
  child.on('error', (err: Error) => {
    console.warn(`[mcp] stdio 子进程错误：${err.message}`)
  })
  // 服务器崩溃/提前 close(0) 时 stdin 管道写入会异步触发 EPIPE 'error'，
  // 该事件发在 stdin socket 上而非 child 上——无监听器同样击穿宿主进程。
  child.stdin.on('error', (err: Error) => {
    console.warn(`[mcp] stdio 写入失败（服务器可能已退出）：${err.message}`)
  })
  child.on('close', () => {
    for (const h of closeHandlers) h()
  })

  return {
    send(msg) {
      if (child.stdin.destroyed) return
      child.stdin.write(`${JSON.stringify(msg)}\n`)
    },
    onMessage(handler) {
      handlers.push(handler)
    },
    onClose(handler) {
      closeHandlers.push(handler)
    },
    close() {
      if (!child.killed) child.kill()
    },
  }
}

/** 从 ReadableStream 增量解析 SSE（`data:` 行 + 空行分事件），收到即回调。 */
async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (data: string) => void,
  shouldStop: () => boolean,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    const consume = (): void => {
      const idx = buffer.indexOf('\n\n')
      if (idx < 0) return
      const eventBlock = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of eventBlock.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trimStart()
        if (data.length > 0) onEvent(data)
      }
      consume()
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 规范允许 CRLF 行结束——归一化为 LF 再按空行分事件，
      // 否则 \r\n\r\n 分隔的事件滞留缓冲区永不派发。
      buffer = buffer.replace(/\r\n/g, '\n')
      consume()
      if (shouldStop()) {
        await reader.cancel()
        break
      }
    }
  } catch {
    // 流被取消/连接被关闭：调用方已不需要继续读取
  }
}

/**
 * Streamable HTTP 传输：每条消息一次 POST，响应按 Content-Type 解析
 * （application/json 直接读 body；text/event-stream 流式解析）。
 * `sse` 为 true 时请求头声明 Accept: text/event-stream（spec §6.2 的 'sse' 传输）。
 * 收到匹配当前请求的 response 后主动取消读取并断连，避免挂住长连接。
 */
function createHttpTransport(
  url: string,
  opts: { sse?: boolean; fetchFn?: FetchFn } = {},
): MCPTransport {
  const fetchFn = opts.fetchFn ?? (fetch as FetchFn)
  const handlers: Array<(msg: MCPIncoming) => void> = []
  const closeHandlers: Array<() => void> = []
  const controller = new AbortController()
  let closed = false

  const emit = (msg: MCPIncoming): void => {
    for (const h of handlers) h(msg)
  }

  const send = (msg: JSONRPCRequest | JSONRPCNotification): void => {
    void (async () => {
      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: opts.sse ? 'text/event-stream' : 'application/json, text/event-stream',
          },
          body: JSON.stringify(msg),
          signal: controller.signal,
        })
        if (!res.ok) {
          emit(errorResponse(msg, `MCP HTTP ${res.status}: ${res.statusText}`))
          return
        }
        const contentType = res.headers.get('content-type') ?? ''
        if (contentType.includes('text/event-stream') && res.body) {
          let receivedResponse = false
          await parseSSEStream(
            res.body,
            (data) => {
              let parsed: MCPIncoming
              try {
                parsed = JSON.parse(data) as MCPIncoming
              } catch {
                return
              }
              if ('id' in parsed && 'id' in msg && parsed.id === msg.id) receivedResponse = true
              emit(parsed)
            },
            () => receivedResponse,
          )
        } else {
          const parsed = (await res.json()) as MCPIncoming
          emit(parsed)
        }
      } catch (err) {
        if (closed) return // close() 触发的 abort，静默
        emit(errorResponse(msg, err instanceof Error ? err.message : String(err)))
      }
    })()
  }

  return {
    send,
    onMessage(handler) {
      handlers.push(handler)
    },
    onClose(handler) {
      closeHandlers.push(handler)
    },
    close() {
      if (closed) return
      closed = true
      controller.abort()
      for (const h of closeHandlers) h()
    },
  }
}

/** 按配置构建生产传输。校验失败抛错（配置面错误，连接前暴露）。 */
function buildTransport(config: {
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
}): MCPTransport {
  if (config.transport === 'stdio') {
    if (!config.command) throw new Error('stdio transport requires "command"')
    return createStdioTransport(config.command, config.args ?? [])
  }
  if (!config.url) throw new Error(`${config.transport} transport requires "url"`)
  return createHttpTransport(config.url, { sse: config.transport === 'sse' })
}

export type { FetchFn, MCPTransport, SpawnFn }
export { buildTransport, createHttpTransport, createStdioTransport, parseSSEStream }
