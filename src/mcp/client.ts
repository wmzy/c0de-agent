// MCP JSON-RPC 客户端（spec §6.1）：request/response 配对（seq id）、超时、
// notification 无响应、连接关闭时 reject 全部 pending。协议纯逻辑，transport 注入。

import type { MCPTransport } from './transport.js'
import type { JSONRPCNotification, JSONRPCRequest, MCPIncoming } from './types.js'

type Pending = {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

type MCPClient = {
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  notify: (method: string, params?: unknown) => void
  close: () => void
}

/** 默认单请求超时（initialize/tools/list 用）；工具调用在调用点传更长的值。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

function createMCPClient(transport: MCPTransport): MCPClient {
  let nextId = 1
  const pending = new Map<number, Pending>()

  const failAll = (message: string): void => {
    for (const p of pending.values()) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error(message))
    }
    pending.clear()
  }

  transport.onMessage((msg: MCPIncoming) => {
    if (!('id' in msg)) return // 服务端通知：当前无订阅方，忽略
    const p = pending.get(msg.id)
    if (!p) return // 已超时/已响应/未知 id
    pending.delete(msg.id)
    if (p.timer) clearTimeout(p.timer)
    if (msg.error) {
      p.reject(
        new Error(
          `MCP ${msg.error.message} (code ${msg.error.code}${msg.error.data ? `, data: ${JSON.stringify(msg.error.data)}` : ''})`,
        ),
      )
    } else {
      p.resolve(msg.result)
    }
  })
  transport.onClose(() => {
    failAll('MCP transport closed')
  })

  return {
    request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
      const id = nextId
      nextId += 1
      const msg: JSONRPCRequest = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      }
      return new Promise((resolve, reject) => {
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                pending.delete(id)
                reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`))
              }, timeoutMs)
            : undefined
        pending.set(id, { resolve, reject, timer })
        transport.send(msg)
      })
    },
    notify(method, params) {
      const msg: JSONRPCNotification = {
        jsonrpc: '2.0',
        method,
        ...(params !== undefined ? { params } : {}),
      }
      transport.send(msg)
    },
    close() {
      failAll('MCP client closed')
      transport.close()
    },
  }
}

export type { MCPClient }
export { createMCPClient, DEFAULT_REQUEST_TIMEOUT_MS }
