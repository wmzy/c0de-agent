import type { AgentDependencies, AgentState, CommandResult } from '../types.js'
import { buildWorkflowContext } from './context.js'
import type { WorkflowRegistry } from './registry.js'
import type { WorkflowEntry } from './types.js'

/** 工作流超时错误（用于 Promise.race 中识别超时）。 */
class WorkflowTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowTimeoutError'
  }
}

/** 等待 ms 后 reject，timer.unref() 保证不阻塞 Node 退出。 */
function createTimeoutPromise(timeoutMs: number, timeoutSeconds: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new WorkflowTimeoutError(`timed out after ${timeoutSeconds}s`)),
      timeoutMs,
    )
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  })
}

/** executeWorkflow 的参数。 */
type ExecuteWorkflowOpts = {
  registry: WorkflowRegistry
  name: string
  args: string
  deps: AgentDependencies
  parent: AgentState
  /** 已解析的 entry（如项目级工作流），优先于 registry.get(name)。 */
  entry?: WorkflowEntry
  onProgress?: (message: string, detail?: unknown) => void
}

/**
 * 执行工作流：查注册表 → 构建 ctx → 调用 entry.execute → 返回 CommandResult。
 *
 * 工作流 return 的 output 作为 text 返回；异常捕获为 error。
 */
async function executeWorkflow(opts: ExecuteWorkflowOpts): Promise<CommandResult> {
  const { registry, name, args, deps, parent, onProgress, entry: resolvedEntry } = opts

  const entry = resolvedEntry ?? registry.get(name)
  if (!entry) {
    const available = registry
      .list()
      .map((e) => e.meta.name)
      .join(', ')
    return {
      _tag: 'error',
      message: `Unknown workflow: "${name}". Available: ${available || '(none)'}`,
    }
  }

  const ctx = buildWorkflowContext({
    deps,
    parent,
    args,
    onProgress: onProgress ?? (() => {}),
  })

  const { timeout } = entry.meta
  const hasTimeout = typeof timeout === 'number' && timeout > 0
  const timeoutSeconds: number | undefined = hasTimeout ? (timeout as number) : undefined

  try {
    const execPromise = entry.execute(ctx)
    const result =
      timeoutSeconds !== undefined
        ? await Promise.race([
            execPromise,
            createTimeoutPromise(timeoutSeconds * 1000, timeoutSeconds),
          ])
        : await execPromise
    return {
      _tag: 'text',
      text: result.output ?? 'Workflow completed (no output).',
    }
  } catch (e) {
    if (e instanceof WorkflowTimeoutError) {
      return {
        _tag: 'error',
        message: `Workflow "${name}" timed out after ${timeoutSeconds}s`,
      }
    }
    return {
      _tag: 'error',
      message: `Workflow "${name}" failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

export { executeWorkflow }
