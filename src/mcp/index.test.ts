import { describe, expect, it, vi } from 'vitest'
import type { MCPServerConfig } from '../shared/types/config.js'
import { createDefaultRegistry } from '../tools/index.js'
import type { ToolContext, ToolRegistry } from '../tools/types.js'
import {
  collectScopedMCPServers,
  connectMCPServer,
  disconnectMCPServer,
  discoverTools,
  registerMCPServers,
} from './index.js'
import type { MCPTransport } from './transport.js'
import type { MCPIncoming } from './types.js'

/** 按脚本回应的假 transport：send 时解析 JSON-RPC，按 method 查表回应。 */
function scriptedTransport(replies: Record<string, unknown>, failMethods?: string[]) {
  const handlers: Array<(msg: MCPIncoming) => void> = []
  const sent: Array<{ method: string; params?: unknown }> = []
  const close = vi.fn()
  const transport = {
    send: (msg: { method: string; params?: unknown; id?: number }) => {
      sent.push({ method: msg.method, params: msg.params })
      if (failMethods?.includes(msg.method)) {
        for (const h of handlers)
          h({ jsonrpc: '2.0', id: msg.id ?? 0, error: { code: -1, message: 'boom' } })
        return
      }
      for (const h of handlers)
        h({ jsonrpc: '2.0', id: msg.id ?? 0, result: replies[msg.method] ?? {} })
    },
    onMessage: (h: (msg: MCPIncoming) => void) => {
      handlers.push(h)
    },
    onClose: () => {},
    close,
  } as MCPTransport
  return { transport, sent, close }
}

const ECHO_TOOL = {
  name: 'echo',
  description: 'Echo back text',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
}

function makeSessionTransport() {
  return scriptedTransport({
    initialize: { protocolVersion: '2025-03-26', capabilities: {} },
    'tools/list': { tools: [ECHO_TOOL] },
    'tools/call': { content: [{ type: 'text', text: 'hi' }], isError: false },
  })
}

describe('connectMCPServer', () => {
  it('performs the initialize handshake and discovers tools', async () => {
    const fake = makeSessionTransport()
    const session = await connectMCPServer(
      { name: 'srv', transport: 'stdio', command: 'x' },
      { transport: fake.transport },
    )
    expect(session.name).toBe('srv')
    expect(session.tools).toEqual([ECHO_TOOL])
    const methods = fake.sent.map((s) => s.method)
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    expect(fake.sent[0]?.params).toMatchObject({ protocolVersion: '2025-03-26' })
  })

  it('closes the client when initialize fails', async () => {
    const fake = scriptedTransport({}, ['initialize'])
    await expect(
      connectMCPServer(
        { name: 'bad', transport: 'stdio', command: 'x' },
        { transport: fake.transport },
      ),
    ).rejects.toThrow(/boom/)
    expect(fake.close).toHaveBeenCalled()
  })

  it('throws on invalid config (stdio without command)', async () => {
    await expect(connectMCPServer({ name: 'x', transport: 'stdio' })).rejects.toThrow(
      /requires "command"/,
    )
  })

  it('throws on invalid config (http without url)', async () => {
    await expect(connectMCPServer({ name: 'x', transport: 'http' })).rejects.toThrow(
      /requires "url"/,
    )
  })
})

describe('discoverTools / disconnectMCPServer', () => {
  it('adapts MCP tools with namespaced names and ask permission', async () => {
    const fake = makeSessionTransport()
    const session = await connectMCPServer(
      { name: 'srv', transport: 'stdio', command: 'x' },
      { transport: fake.transport },
    )
    const defs = discoverTools(session)
    expect(defs).toHaveLength(1)
    expect(defs[0]).toMatchObject({
      name: 'mcp__srv__echo',
      permission: 'ask',
      parameters: ECHO_TOOL.inputSchema,
    })
    expect(defs[0]?.description).toContain('Echo back text')
  })

  it('executing an adapted tool calls tools/call and maps the text result', async () => {
    const fake = makeSessionTransport()
    const session = await connectMCPServer(
      { name: 'srv', transport: 'stdio', command: 'x' },
      { transport: fake.transport },
    )
    const [def] = discoverTools(session)
    const result = await def?.execute?.({ text: 'abc' }, {} as ToolContext)
    expect(result).toEqual({ _tag: 'success', output: 'hi' })
    const call = fake.sent.find((s) => s.method === 'tools/call')
    expect(call?.params).toEqual({ name: 'echo', arguments: { text: 'abc' } })
  })

  // 复现：工具名 `mcp__<server>__<tool>` 由配置里的服务器名与远端工具名直接拼成，
  // 两侧都未按 provider 的函数名文法（OpenAI/Anthropic 一致：^[a-zA-Z0-9_-]{1,64}$）
  // 规范化。照抄 npm 包名当服务器名（`@modelcontextprotocol/server-filesystem`）或
  // 远端工具名带点（`fs.read_file`）时，请求体的 tools[].function.name 非法——
  // provider 400 拒绝**整个请求**：不是这台服务器的工具不可用，而是该工作区所有
  // 对话都发不出去。
  it('服务器名/工具名含非法字符时规范化为 provider 函数名，且仍以原始名调用远端工具', async () => {
    const fake = scriptedTransport({
      initialize: { protocolVersion: '2025-03-26', capabilities: {} },
      'tools/list': {
        tools: [
          {
            name: 'fs.read_file',
            description: 'Read a file',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
      'tools/call': { content: [{ type: 'text', text: 'ok' }], isError: false },
    })
    const session = await connectMCPServer(
      { name: '@modelcontextprotocol/server-filesystem', transport: 'stdio', command: 'x' },
      { transport: fake.transport },
    )
    const [def] = discoverTools(session)
    expect(def?.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    const result = await def?.execute?.({}, {} as ToolContext)
    expect(result).toEqual({ _tag: 'success', output: 'ok' })
    // 调用必须带远端原始工具名（规范化只作用于暴露给模型的函数名）
    expect(fake.sent.find((s) => s.method === 'tools/call')?.params).toEqual({
      name: 'fs.read_file',
      arguments: {},
    })
  })

  it('超长服务器名/工具名截断后仍满足函数名文法且保持工具名可辨识', async () => {
    const longTool = `very_${'long_'.repeat(20)}tool_name`
    const fake = scriptedTransport({
      initialize: { protocolVersion: '2025-03-26', capabilities: {} },
      'tools/list': {
        tools: [{ name: longTool, description: 'd', inputSchema: { type: 'object' } }],
      },
      'tools/call': { content: [{ type: 'text', text: 'ok' }], isError: false },
    })
    const session = await connectMCPServer(
      { name: 's'.repeat(80), transport: 'stdio', command: 'x' },
      { transport: fake.transport },
    )
    const [def] = discoverTools(session)
    expect(def?.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(def?.name.endsWith('tool_name')).toBe(true)
  })

  it('maps isError results to error ToolResult', async () => {
    const fake = scriptedTransport({
      initialize: {},
      'tools/list': { tools: [ECHO_TOOL] },
      'tools/call': { content: [{ type: 'text', text: 'failed' }], isError: true },
    })
    const session = await connectMCPServer(
      { name: 'srv', transport: 'stdio', command: 'x' },
      { transport: fake.transport },
    )
    const [def] = discoverTools(session)
    const result = await def?.execute?.({}, {} as ToolContext)
    expect(result).toEqual({ _tag: 'error', error: 'failed' })
  })

  it('disconnect closes the session', async () => {
    const fake = makeSessionTransport()
    const session = await connectMCPServer(
      { name: 'srv', transport: 'stdio', command: 'x' },
      { transport: fake.transport },
    )
    disconnectMCPServer(session)
    expect(fake.close).toHaveBeenCalled()
  })
})

describe('registerMCPServers', () => {
  function echoServer(): MCPServerConfig {
    return { name: 'echo-srv', transport: 'stdio', command: 'node', args: ['srv.js'] }
  }

  it('registers adapted tools and isolates per-server failures', async () => {
    const registry: ToolRegistry = createDefaultRegistry()
    let echoConnect = 0
    const result = await registerMCPServers(
      registry,
      [{ name: 'broken', transport: 'stdio', command: 'x' }, echoServer()],
      {
        createTransport: (config) => {
          if (config.name === 'broken') throw new Error('spawn ENOENT')
          echoConnect += 1
          return makeSessionTransport().transport
        },
      },
    )
    expect(result.failures).toEqual(['broken: spawn ENOENT'])
    expect(result.sessions).toHaveLength(1)
    expect(echoConnect).toBe(1)
    expect(registry.tools.has('mcp__echo-srv__echo')).toBe(true)
  })

  it('registers no tools when tools/list returns empty', async () => {
    const registry: ToolRegistry = createDefaultRegistry()
    const fake = scriptedTransport({ initialize: {}, 'tools/list': { tools: [] } })
    const result = await registerMCPServers(registry, [echoServer()], {
      createTransport: () => fake.transport,
    })
    expect(result.sessions).toHaveLength(1)
    expect(registry.tools.size).toBeGreaterThanOrEqual(0)
    expect(registry.tools.has('mcp__echo-srv__echo')).toBe(false)
  })
})

describe('collectScopedMCPServers', () => {
  const global = { mcpServers: [{ name: 'g', transport: 'stdio' as const, command: 'x' }] }
  const project = { mcpServers: [{ name: 'p', transport: 'stdio' as const, command: 'y' }] }

  it('always includes global servers, project only when trusted', () => {
    expect(collectScopedMCPServers({ global }, false).map((s) => s.name)).toEqual(['g'])
    expect(collectScopedMCPServers({ global, project }, false).map((s) => s.name)).toEqual(['g'])
    expect(collectScopedMCPServers({ global, project }, true).map((s) => s.name)).toEqual([
      'g',
      'p',
    ])
  })

  it('filters invalid entries and non-array values', () => {
    expect(
      collectScopedMCPServers(
        {
          global: {
            mcpServers: [
              { name: 'a', transport: 'stdio' },
              null,
              { nope: 1 },
            ] as unknown as MCPServerConfig[],
          },
        },
        true,
      ).map((s) => s.name),
    ).toEqual(['a'])
    expect(
      collectScopedMCPServers(
        { global: { mcpServers: 'nope' as unknown as MCPServerConfig[] } },
        true,
      ),
    ).toEqual([])
  })
})
