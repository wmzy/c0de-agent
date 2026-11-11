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
  // dispose 后拒绝新请求/通知、不再向已关 transport 发送（语义同 DAP client）
  let disposed = false

  /** 单一幂等终结路径（与 DAP protocol.ts 同骨架）：清 timer → 出表 → 终结。
   *  响应/超时/关闭全部终态必经此处——三处各自手写 map-delete/timer-clear
   *  必然漂移（漏清 timer、重复终结等）。未知 id 静默忽略（已超时/已响应）。 */
  const settle = (id: number, fn: (p: Pending) => void): void => {
    const p = pending.get(id)
    if (!p) return
    if (p.timer) clearTimeout(p.timer)
    pending.delete(id)
    fn(p)
  }

  const failAll = (message: string): void => {
    for (const id of Array.from(pending.keys())) {
      settle(id, (p) => p.reject(new Error(message)))
    }
  }

  transport.onMessage((msg: MCPIncoming) => {
    if (!('id' in msg)) return // 服务端通知：当前无订阅方，忽略
    settle(msg.id, (p) => {
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
  })
  transport.onClose(() => {
    disposed = true
    failAll('MCP transport closed')
  })

  return {
    request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
      if (disposed) return Promise.reject(new Error('MCP client disposed'))
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
            ? setTimeout(
                () =>
                  settle(id, (p) =>
                    p.reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`)),
                  ),
                timeoutMs,
              )
            : undefined
        pending.set(id, { resolve, reject, timer })
        transport.send(msg)
      })
    },
    notify(method, params) {
      if (disposed) return
      const msg: JSONRPCNotification = {
        jsonrpc: '2.0',
        method,
        ...(params !== undefined ? { params } : {}),
      }
      transport.send(msg)
    },
    close() {
      if (disposed) return
      disposed = true
      failAll('MCP client closed')
      transport.close()
    },
  }
}

export type { MCPClient }
export { createMCPClient, DEFAULT_REQUEST_TIMEOUT_MS }
