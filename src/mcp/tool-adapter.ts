// MCP tool → 内部 ToolDef 适配（spec §6.2）：MCP 工具的 inputSchema 直接映射为
// ToolDef.parameters；工具名命名空间化为 `mcp__<server>__<tool>` 防与内置/跨服务器
// 冲突；执行时经 session 发 tools/call 并把 MCP content 折回 ToolResult。
// 权限 ask：MCP 服务器是外部任意代码执行面（与插件同级），默认需确认。

import type { ToolDef, ToolResult } from '../shared/types/tool.js'
import type { MCPCallResult, MCPSession, MCPTool } from './types.js'

/** 工具调用超时：外部服务器执行可慢，给足余量。 */
const TOOL_CALL_TIMEOUT_MS = 120_000

function toolName(sessionName: string, name: string): string {
  return `mcp__${sessionName}__${name}`
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
