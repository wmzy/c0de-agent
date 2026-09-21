import type { ToolContext, ToolDef, ToolResult } from '../shared/types/tool.js'
import { getTool } from './registry.js'
import { truncateOutput } from './truncate.js'
import type { PermissionChecker, ToolRegistry } from './types.js'
import { validateInput } from './validate.js'

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
    // ToolDef.timeout 声明必须兑现：此前直接 await tool.execute，声明的超时
    // （websearch 30s）从未执行——后端 fetch 挂起时整个 agent run 无限期挂死，
    // 只有用户手动 abort 才能脱身。超时经派生 AbortController 注入工具 ctx：
    // 底层 IO（fetch 等）随超时取消，不再后台残留；外层 run abort 同样级联。
    const result =
      tool.timeout !== undefined && tool.timeout > 0
        ? await executeWithTimeout(tool, input, ctx)
        : await tool.execute(input, ctx)

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

/**
 * 在声明超时内执行工具：派生 abort 信号（外层 run abort 级联），超时先 abort
 * 再以明确错误拒绝。Promise.race 的晚到 resolve 被忽略；工具自身若无视 abort
 * 继续执行，其结果被丢弃，但错误信息与超时语义不受影响。
 */
async function executeWithTimeout(
  tool: ToolDef,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const timeout = tool.timeout ?? 0
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  ctx.abort.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      tool.execute(input, { ...ctx, abort: controller.signal }),
      new Promise<ToolResult>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          // 外层 catch 会加 "Tool \"x\" failed:" 前缀，这里不再重复工具名
          reject(new Error(`timed out after ${timeout}ms`))
        }, timeout)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    ctx.abort.removeEventListener('abort', onAbort)
  }
}
