import type { HookRunner } from '../plugins/types.js'
import type { ToolContext, ToolResult } from '../shared/types/tool.js'
import { executeTool } from '../tools/executor.js'
import type { PermissionChecker, ToolRegistry } from '../tools/types.js'

type CollectedToolCall = {
  id: string
  tool: string
  input: unknown
}

type ToolCallResult = {
  id: string
  result: ToolResult
}

const WRITE_TOOLS = new Set(['write', 'edit', 'bash'])

async function executeToolCall(
  registry: ToolRegistry,
  permission: PermissionChecker,
  ctx: ToolContext,
  name: string,
  input: unknown,
  hookRunner?: HookRunner,
): Promise<ToolResult> {
  let effectiveInput = input

  if (hookRunner) {
    const hookResult = await hookRunner.runHooks('tool:before', { tool: name, input, ctx })
    if (hookResult === false) {
      return { _tag: 'error', error: `Tool "${name}" aborted by hook` }
    }
    effectiveInput = hookResult.input
  }

  const result = await executeTool(registry, name, effectiveInput, ctx, permission)

  if (hookRunner) {
    await hookRunner.fireHooks('tool:after', { tool: name, input: effectiveInput, result, ctx })
  }

  return result
}

function partitionByConflict(calls: CollectedToolCall[]): {
  parallel: CollectedToolCall[]
  serial: CollectedToolCall[]
} {
  const parallel: CollectedToolCall[] = []
  const serial: CollectedToolCall[] = []
  const writePaths = new Set<string>()

  for (const tc of calls) {
    if (WRITE_TOOLS.has(tc.tool)) {
      const input = tc.input as Record<string, unknown> | undefined
      const path = (input?.path ?? input?.file) as string | undefined
      if (path && writePaths.has(path)) {
        serial.push(tc)
      } else {
        if (path) writePaths.add(path)
        parallel.push(tc)
      }
    } else {
      parallel.push(tc)
    }
  }

  return { parallel, serial }
}

async function executeToolCalls(
  registry: ToolRegistry,
  permission: PermissionChecker,
  ctx: ToolContext,
  calls: CollectedToolCall[],
  hookRunner?: HookRunner,
): Promise<ToolCallResult[]> {
  const { parallel, serial } = partitionByConflict(calls)
  const results: ToolCallResult[] = []

  if (parallel.length > 0) {
    const settled = await Promise.allSettled(
      parallel.map(async (tc) => ({
        id: tc.id,
        result: await executeToolCall(registry, permission, ctx, tc.tool, tc.input, hookRunner),
      })),
    )
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value)
      } else {
        results.push({ id: 'unknown', result: { _tag: 'error', error: String(s.reason) } })
      }
    }
  }

  for (const tc of serial) {
    const result = await executeToolCall(registry, permission, ctx, tc.tool, tc.input, hookRunner)
    results.push({ id: tc.id, result })
  }

  return results
}

export type { CollectedToolCall, ToolCallResult }
export { executeToolCall, executeToolCalls, partitionByConflict }
