// MCP（Model Context Protocol）客户端协议类型（spec §6）。
// 零外部依赖的最小 JSON-RPC 2.0 子集 + 工具描述/调用结果。

import type { JSONSchema } from '../shared/types/base.js'
import type { MCPServerConfig } from '../shared/types/config.js'

/** JSON-RPC 2.0 request（client → server，带 id，期待 response）。 */
type JSONRPCRequest = {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

/** JSON-RPC 2.0 notification（client → server，无 id，不期待响应）。 */
type JSONRPCNotification = {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

/** JSON-RPC 2.0 response（server → client）。 */
type JSONRPCResponse = {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** 服务端发来的消息：响应或通知。 */
type MCPIncoming = JSONRPCResponse | JSONRPCNotification

/** MCP tools/list 返回的单个工具描述（inputSchema 是 JSON Schema）。 */
type MCPTool = {
  name: string
  description?: string
  inputSchema: JSONSchema
}

/** MCP tools/call 返回结果：content 数组（text 为主），isError 标记工具语义失败。 */
type MCPCallResult = {
  content: Array<{ type: string; [key: string]: unknown }>
  isError?: boolean
}

/** 已连接的 MCP 会话：持有连接与已发现工具，供 tool-adapter 消费。 */
type MCPSession = {
  /** 配置中的服务器名（工具命名空间来源）。 */
  name: string
  config: MCPServerConfig
  /** tools/list 快照（连接时发现，会话内不变）。 */
  tools: MCPTool[]
  /** 发送 JSON-RPC request（带默认超时，可覆盖）。 */
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  /** 关闭底层连接。幂等。 */
  close: () => void
}

export type {
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResponse,
  MCPCallResult,
  MCPIncoming,
  MCPSession,
  MCPTool,
}
