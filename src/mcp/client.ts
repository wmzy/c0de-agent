// MCP JSON-RPC 客户端（spec §6.1）：request/response 配对（seq id）、超时、
// notification 无响应、连接关闭时 reject 全部 pending。协议纯逻辑，transport 注入。

import { createPendingRequests } from '../shared/jsonrpc-pending.js'
import type { MCPTransport } from './transport.js'
import type { JSONRPCNotification, JSONRPCRequest, MCPIncoming } from './types.js'

type MCPClient = {
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  notify: (method: string, params?: unknown) => void
  close: () => void
}

/** 默认单请求超时（initialize/tools/list 用）；工具调用在调用点传更长的值。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

function createMCPClient(transport: MCPTransport): MCPClient {
  let nextId = 1
  // pending 骨架（幂等 settle / 超时 reject / failAll）收敛于 shared 单一实现
  //（与 DAP protocol.ts 同源），本文件只保留 id 计数与 MCP 响应/错误语义。
  const requests = createPendingRequests('MCP')
  // dispose 后拒绝新请求/通知、不再向已关 transport 发送（语义同 DAP client）
  let disposed = false

  transport.onMessage((msg: MCPIncoming) => {
    if (!('id' in msg)) return // 服务端通知：当前无订阅方，忽略
    requests.settle(msg.id, (p) => {
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
    requests.failAll('MCP transport closed')
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
        requests.add(id, { resolve, reject }, { timeoutMs, name: method })
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
      requests.failAll('MCP client closed')
      transport.close()
    },
  }
}

export type { MCPClient }
export { createMCPClient, DEFAULT_REQUEST_TIMEOUT_MS }
