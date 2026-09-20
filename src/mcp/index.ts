// MCP 包入口（spec §6）：连接外部 MCP 服务器（stdio / http / sse），发现其工具，
// 适配为内部 ToolDef 并注册进 ToolRegistry——对 agent 透明，与内置工具同接口。
//
// 连接失败（配置坏/服务器不可用）不抛给宿主：registerMCPServers 逐台隔离，
// 失败告警并跳过该台（与插件加载「单个坏插件不影响其余」同口径），
// 保证一个坏 MCP 配置不会拖垮 serve/chat 启动。

import type { Config, MCPServerConfig } from '../shared/types/config.js'
import type { ToolDef, ToolResult } from '../shared/types/tool.js'
import { registerTool } from '../tools/registry.js'
import type { ToolRegistry } from '../tools/types.js'
import { createMCPClient } from './client.js'
import { adaptMCPTool, mcpResultToToolResult } from './tool-adapter.js'
import { buildTransport, type MCPTransport } from './transport.js'
import type { MCPSession, MCPTool } from './types.js'

/** initialize/tools/list 的默认超时。 */
const CONNECT_TIMEOUT_MS = 30_000

type ConnectOptions = {
  /** initialize/tools/list 超时（默认 30s）。 */
  timeoutMs?: number
  /** 测试注入：直接提供 transport，跳过按配置构建。 */
  transport?: MCPTransport
  /** 测试注入：按配置构建 transport 的工厂（默认 buildTransport）。 */
  createTransport?: (config: MCPServerConfig) => MCPTransport
}

/** 连接一个 MCP 服务器：initialize 握手 → tools/list → 返回会话。失败抛错。 */
async function connectMCPServer(
  config: MCPServerConfig,
  opts: ConnectOptions = {},
): Promise<MCPSession> {
  const transport = opts.transport ?? (opts.createTransport ?? buildTransport)(config)
  const client = createMCPClient(transport)
  try {
    const timeoutMs = opts.timeoutMs ?? CONNECT_TIMEOUT_MS
    await client.request(
      'initialize',
      {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'c0de-agent', version: '0.0.0' },
      },
      timeoutMs,
    )
    // 握手后半步：声明客户端已就绪（notifications/initialized）。
    client.notify('notifications/initialized')
    const list = (await client.request('tools/list', undefined, timeoutMs)) as
      | { tools?: MCPTool[] }
      | undefined
    const tools = Array.isArray(list?.tools) ? list.tools : []
    return {
      name: config.name,
      config,
      tools,
      request: (method, params, t) => client.request(method, params, t),
      close: () => client.close(),
    }
  } catch (error) {
    client.close()
    throw error
  }
}

/** 会话已发现工具 → 内部 ToolDef[]（spec §6.2 discoverTools）。 */
function discoverTools(session: MCPSession): ToolDef[] {
  return session.tools.map((t) => adaptMCPTool(session, t))
}

/** 直接调用一个 MCP 工具（spec §6.2 callMCPTool）。 */
async function callMCPTool(session: MCPSession, name: string, args: unknown): Promise<ToolResult> {
  try {
    const result = await session.request('tools/call', { name, arguments: args ?? {} })
    return mcpResultToToolResult(result)
  } catch (error) {
    return { _tag: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

/** 断开连接（spec §6.2 disconnectMCPServer）。幂等。 */
function disconnectMCPServer(session: MCPSession): void {
  session.close()
}

type RegisterResult = {
  /** 已连接会话（宿主持有，用于关闭清理）。 */
  sessions: MCPSession[]
  /** 连接失败列表：`<serverName>: <原因>`。 */
  failures: string[]
}

type RegisterOptions = {
  timeoutMs?: number
  createTransport?: (config: MCPServerConfig) => MCPTransport
}

/** 连接多台 MCP 服务器并把工具注册进 registry。逐台隔离，失败不抛。 */
async function registerMCPServers(
  registry: ToolRegistry,
  servers: MCPServerConfig[],
  opts: RegisterOptions = {},
): Promise<RegisterResult> {
  const sessions: MCPSession[] = []
  const failures: string[] = []
  for (const server of servers) {
    try {
      const session = await connectMCPServer(server, opts)
      sessions.push(session)
      for (const def of discoverTools(session)) {
        registerTool(registry, def)
      }
      if (session.tools.length > 0) {
        console.info(
          `[mcp] 已连接 ${server.name}（${server.transport}），注册 ${session.tools.length} 个工具`,
        )
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failures.push(`${server.name}: ${reason}`)
      console.warn(`[mcp] 连接 ${server.name} 失败，跳过该服务器：${reason}`)
    }
  }
  return { sessions, failures }
}

/**
 * 从配置作用域收集「当前应连接」的 MCP 服务器：
 * 全局作用域（用户本机显式配置）始终连接；项目作用域（随 git clone 传播的
 * 任意命令执行面）仅在项目已信任时连接——与插件加载、工作流发现同口径。
 */
function collectScopedMCPServers(
  scopes: { global?: Partial<Config>; project?: Partial<Config> },
  projectTrusted: boolean,
): MCPServerConfig[] {
  const out: MCPServerConfig[] = []
  const add = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue
      const e = entry as MCPServerConfig
      if (typeof e.name !== 'string' || typeof e.transport !== 'string') continue
      out.push(e)
    }
  }
  add(scopes.global?.mcpServers)
  if (projectTrusted) add(scopes.project?.mcpServers)
  return out
}

export type { ConnectOptions, RegisterOptions, RegisterResult }
export {
  CONNECT_TIMEOUT_MS,
  callMCPTool,
  collectScopedMCPServers,
  connectMCPServer,
  disconnectMCPServer,
  discoverTools,
  registerMCPServers,
}
