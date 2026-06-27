import type { ChatTool } from '../shared/types/llm.js'
import type { ToolDef } from '../shared/types/tool.js'
import type { ToolFactory, ToolFactoryContext, ToolRegistry } from './types.js'

/** Create an empty tool registry. */
export function createToolRegistry(): ToolRegistry {
  return { tools: new Map(), factories: new Map() }
}

/** Register a fully-constructed tool definition (eager). */
export function registerTool(registry: ToolRegistry, tool: ToolDef): void {
  registry.tools.set(tool.name, tool)
}

/** Register a lazy factory that constructs the tool on first access. */
export function registerToolFactory(
  registry: ToolRegistry,
  name: string,
  factory: ToolFactory,
): void {
  registry.factories.set(name, factory)
}

/** Get a tool by name. Triggers and caches lazy factories. Returns undefined if not found. */
export function getTool(
  registry: ToolRegistry,
  name: string,
  ctx?: ToolFactoryContext,
): ToolDef | undefined {
  // Check eager tools first
  const eager = registry.tools.get(name)
  if (eager) return eager

  // Check lazy factories
  const factory = registry.factories.get(name)
  if (factory && ctx) {
    const tool = factory(ctx)
    if (tool) {
      registry.tools.set(name, tool) // cache
      registry.factories.delete(name)
      return tool
    }
    // Factory returned null → remove
    registry.factories.delete(name)
  }

  return undefined
}

/** List all tools. Triggers and caches all lazy factories. */
export function listTools(registry: ToolRegistry, ctx?: ToolFactoryContext): ToolDef[] {
  // Materialize factories if context is provided
  if (ctx) {
    for (const [name, factory] of registry.factories) {
      const tool = factory(ctx)
      if (tool) {
        registry.tools.set(name, tool)
      }
      registry.factories.delete(name)
    }
  }
  return Array.from(registry.tools.values())
}

/** Convert registered tools to ChatTool[] for sending to the LLM. */
export function getToolSchemas(registry: ToolRegistry, ctx?: ToolFactoryContext): ChatTool[] {
  return listTools(registry, ctx).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
}
