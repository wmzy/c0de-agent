// MCP tool → 内部 ToolDef 适配（spec §6.2）：MCP 工具的 inputSchema 直接映射为
// ToolDef.parameters；工具名命名空间化为 `mcp__<server>__<tool>` 防与内置/跨服务器
// 冲突；执行时经 session 发 tools/call 并把 MCP content 折回 ToolResult。
// 权限 ask：MCP 服务器是外部任意代码执行面（与插件同级），默认需确认。

import type { ToolDef, ToolResult } from '../shared/types/tool.js'
import type { MCPCallResult, MCPSession, MCPTool } from './types.js'

/** 工具调用超时：外部服务器执行可慢，给足余量。 */
const TOOL_CALL_TIMEOUT_MS = 120_000

/** provider 的函数名文法（OpenAI 与 Anthropic 一致）：`^[a-zA-Z0-9_-]{1,64}$`。
 *  服务器名来自用户配置、工具名来自远端服务——两者都可能带 `.`/`@`/`/`/空格
 *  （例如照抄 npm 包名 `@modelcontextprotocol/server-filesystem`）或超长。未规范化
 *  就拼进该槽位时，请求体 tools[].function.name 非法，provider 400 拒绝**整个请求**：
 *  不是这台服务器的工具不可用，而是该工作区所有对话都发不出去。 */
const TOOL_NAME_MAX = 64
const TOOL_NAME_SEP = '__'
const TOOL_NAME_PREFIX = 'mcp'

/** 规范化单个名字片段：非法字符折成 `_`，去掉首尾 `_`。 */
function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
}

/** MCP 工具名 → provider 函数名：`mcp__<server>__<tool>`，两侧片段各自规范化并按
 *  64 字符上限分配预算。超长时优先保留工具名（截尾保尾：工具语义在尾部，同一
 *  服务器下的不同工具因此仍互不相同），服务器名段相应截断。 */
function toolName(sessionName: string, name: string): string {
  const server = sanitizeSegment(sessionName) || 'server'
  const tool = sanitizeSegment(name) || 'tool'
  const budget = TOOL_NAME_MAX - TOOL_NAME_PREFIX.length - TOOL_NAME_SEP.length * 2
  const keepTool = tool.length < budget ? tool : tool.slice(-(budget - 1))
  const keepServer = server.slice(0, Math.max(1, budget - keepTool.length))
  return `${TOOL_NAME_PREFIX}${TOOL_NAME_SEP}${keepServer}${TOOL_NAME_SEP}${keepTool}`
}

/** MCP tools/call 结果 → ToolResult：text 内容拼接；isError 标记映射为 error。 */
function mcpResultToToolResult(result: unknown): ToolResult {
  const r = result as MCPCallResult | undefined
  const parts = Array.isArray(r?.content) ? r.content : []
  const text = parts
    .filter((c) => c !== null && typeof c === 'object' && c.type === 'text')
    .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c.text)))
    .join('\n')
  if (r?.isError) {
    return { _tag: 'error', error: text || 'MCP tool reported an error' }
  }
  if (text.length === 0) {
    const nonText = parts.length > 0 ? `（${parts.length} 个非文本 content 项，不支持渲染）` : ''
    return { _tag: 'success', output: `(empty result)${nonText}` }
  }
  return { _tag: 'success', output: text }
}

/** 把一个 MCP 工具适配为内部 ToolDef（execute 闭包持有 session）。 */
function adaptMCPTool(session: MCPSession, tool: MCPTool): ToolDef {
  return {
    name: toolName(session.name, tool.name),
    description:
      tool.description?.trim() || `MCP tool \`${tool.name}\` from server \`${session.name}\`.`,
    parameters: tool.inputSchema,
    permission: 'ask',
    execute: async (input: unknown): Promise<ToolResult> => {
      try {
        const result = await session.request(
          'tools/call',
          { name: tool.name, arguments: input ?? {} },
          TOOL_CALL_TIMEOUT_MS,
        )
        return mcpResultToToolResult(result)
      } catch (error) {
        return { _tag: 'error', error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

export type { MCPSession, MCPTool }
export { adaptMCPTool, mcpResultToToolResult, TOOL_CALL_TIMEOUT_MS, toolName }
