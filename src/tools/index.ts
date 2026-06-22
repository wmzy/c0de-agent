// @c0de/tools - Tool registry, executor, builtin tools

export const VERSION = "0.0.1";

export type { Tool, ToolContext, ToolRegistry, ToolResult } from "./types";
export { InMemoryToolRegistry, createRegistry } from "./registry";
export { DefaultToolExecutor, createExecutor } from "./executor";
export type { ToolExecutor } from "./executor";

export { bashTool } from "./bash";
export { readFileTool, writeFileTool } from "./file";
export { grepTool, listFilesTool } from "./search";

import { bashTool } from "./bash";
import { readFileTool, writeFileTool } from "./file";
import { createRegistry } from "./registry";
import { grepTool, listFilesTool } from "./search";
import type { ToolRegistry } from "./types";

export function createDefaultRegistry(): ToolRegistry {
  const registry = createRegistry();
  registry.register(bashTool);
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(grepTool);
  registry.register(listFilesTool);
  return registry;
}
