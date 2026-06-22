// Tool executor

import type { ToolCall } from '../llm'
import type { ToolContext, ToolRegistry, ToolResult } from './types'

export interface ToolExecutor {
  execute(toolCall: ToolCall, context: ToolContext): Promise<ToolResult>
}

export class DefaultToolExecutor implements ToolExecutor {
  constructor(private registry: ToolRegistry) {}

  async execute(toolCall: ToolCall, context: ToolContext): Promise<ToolResult> {
    const tool = this.registry.get(toolCall.function.name)

    if (!tool) {
      return {
        output: '',
        error: `Unknown tool: ${toolCall.function.name}`,
      }
    }

    try {
      const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
      return await tool.execute(args, context)
    } catch (error) {
      return {
        output: '',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

export function createExecutor(registry: ToolRegistry): ToolExecutor {
  return new DefaultToolExecutor(registry)
}
