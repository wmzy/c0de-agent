import { BUILTIN_WORKFLOWS } from './builtins.js'
import { discoverWorkflows } from './discovery.js'
import type { WorkflowEntry } from './types.js'

/** 工作流注册表：内存 Map<name, WorkflowEntry>，后注册覆盖同名。 */
function createWorkflowRegistry() {
  const entries = new Map<string, WorkflowEntry>()

  return {
    register(entry: WorkflowEntry) {
      entries.set(entry.meta.name, entry)
    },
    get(name: string): WorkflowEntry | undefined {
      return entries.get(name)
    },
    list(): WorkflowEntry[] {
      return Array.from(entries.values())
    },
    has(name: string): boolean {
      return entries.has(name)
    },
    delete(name: string): boolean {
      return entries.delete(name)
    },
  }
}

type WorkflowRegistry = ReturnType<typeof createWorkflowRegistry>

/**
 * 创建并填充工作流注册表：
 *  1. 注册内置工作流
 *  2. 发现并注册项目 `.c0de/workflows/*.js`
 *  后注册覆盖同名（project > builtin）。
 */
async function createAndPopulateRegistry(projectDir: string): Promise<WorkflowRegistry> {
  const registry = createWorkflowRegistry()
  // 1. 内置
  for (const wf of BUILTIN_WORKFLOWS) {
    registry.register(wf)
  }
  // 2. 项目级
  const discovered = await discoverWorkflows(projectDir)
  for (const wf of discovered) {
    registry.register(wf)
  }
  return registry
}

export type { WorkflowRegistry }
export { createAndPopulateRegistry, createWorkflowRegistry }
