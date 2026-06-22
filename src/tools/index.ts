export type { Tool, ToolContext, ToolRegistry, ToolResult } from './types'
export { InMemoryToolRegistry, createRegistry } from './registry'
export { DefaultToolExecutor, createExecutor } from './executor'
export type { ToolExecutor } from './executor'

export { bashTool } from './bash'
export { readFileTool, writeFileTool } from './file'

import { createRegistry } from './registry'
import { bashTool } from './bash'
import { readFileTool, writeFileTool } from './file'
import type { ToolRegistry } from './types'

export function createDefaultRegistry(): ToolRegistry {
  const registry = createRegistry()
  registry.register(bashTool)
  registry.register(readFileTool)
  registry.register(writeFileTool)
  return registry
}
