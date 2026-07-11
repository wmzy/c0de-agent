import type { AgentDependencies, AgentState, CommandResult } from '../types.js'
import { buildWorkflowContext } from './context.js'
import type { WorkflowRegistry } from './registry.js'

/** executeWorkflow 的参数。 */
type ExecuteWorkflowOpts = {
  registry: WorkflowRegistry
  name: string
  args: string
  deps: AgentDependencies
  parent: AgentState
  onProgress?: (message: string, detail?: unknown) => void
}

/**
 * 执行工作流：查注册表 → 构建 ctx → 调用 entry.execute → 返回 CommandResult。
 *
 * 工作流 return 的 output 作为 text 返回；异常捕获为 error。
 */
async function executeWorkflow(opts: ExecuteWorkflowOpts): Promise<CommandResult> {
  const { registry, name, args, deps, parent, onProgress } = opts

  const entry = registry.get(name)
  if (!entry) {
    const available = registry.list().map((e) => e.meta.name).join(', ')
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

  try {
    const result = await entry.execute(ctx)
    return {
      _tag: 'text',
      text: result.output ?? 'Workflow completed (no output).',
    }
  } catch (e) {
    return {
      _tag: 'error',
      message: `Workflow "${name}" failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

export { executeWorkflow }