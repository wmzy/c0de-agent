// @c0de/tools - Tool registry implementation

import type { ToolDefinition } from "@c0de/llm";
import type { Tool, ToolRegistry } from "./types";

export class InMemoryToolRegistry implements ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  toDefinitions(): ToolDefinition[] {
    return this.list().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
}

export function createRegistry(): ToolRegistry {
  return new InMemoryToolRegistry();
}
