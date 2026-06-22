// Tool types

import type { ToolDefinition } from '../llm'

export interface ToolContext {
  workingDirectory: string
  env: Record<string, string | undefined>
}

export interface ToolResult {
  output: string
  error?: string
}

export interface Tool {
  name: string
  description: string
  parameters: ToolDefinition['function']['parameters']
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
}

export interface ToolRegistry {
  register(tool: Tool): void
  get(name: string): Tool | undefined
  list(): Tool[]
  toDefinitions(): ToolDefinition[]
}
