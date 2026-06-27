import type { ToolContext, ToolResult } from '../shared/types/tool.js'
import type { PermissionChecker, ToolRegistry } from './types.js'
import { getTool } from './registry.js'
import { validateInput } from './validate.js'
import { truncateOutput } from './truncate.js'

/**
 * Execute a tool by name with full pipeline:
 * find tool → validate input → check permission → execute → truncate output.
 *
 * Returns the ToolResult. Never throws — all errors become { _tag: 'error' }.
 */
export async function executeTool(
  registry: ToolRegistry,
  name: string,
  input: unknown,
  ctx: ToolContext,
  permissionChecker: PermissionChecker,
): Promise<ToolResult> {
  // 0. Check abort signal
  if (ctx.abort.aborted) {
    return { _tag: 'error', error: 'Operation aborted before execution' }
  }

  // 1. Find tool
  const tool = getTool(registry, name, { config: {}, cwd: ctx.cwd })
  if (!tool) {
    return { _tag: 'error', error: `Tool not found: ${name}` }
  }

  // 2. Validate input against JSON Schema
  const validation = validateInput(tool.parameters, input)
  if (!validation.valid) {
    return { _tag: 'error', error: `Invalid input for "${name}": ${validation.error}` }
  }

  // 3. Check permission
  const permission = await permissionChecker.check(tool, input, ctx)
  if (permission._tag === 'deny') {
    return { _tag: 'error', error: `Permission denied: ${permission.reason}` }
  }
  if (permission._tag === 'ask') {
    return { _tag: 'permission_required', reason: permission.reason }
  }

  // 4. Execute
  try {
    const result = await tool.execute(input, ctx)

    // 5. Truncate large output
    if (result._tag === 'success') {
      const truncated = truncateOutput(result.output)
      if (truncated.truncated) {
        return {
          _tag: 'truncated',
          output: truncated.output,
          truncated: true,
          totalLines: truncated.totalLines,
        }
      }
    }

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { _tag: 'error', error: `Tool "${name}" failed: ${message}` }
  }
}
