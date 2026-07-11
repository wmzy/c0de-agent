import { createBuiltinWorkflows } from './builtins.js'
import { discoverGlobalWorkflows, discoverWorkflows } from './discovery.js'
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
 * 创建并填充工作流注册表（三级发现，后注册覆盖同名）：
 *  1. 注册内置工作流（builtin）
 *  2. 发现并注册全局 `~/.c0de/workflows/*.js`（user）
 *  3. 发现并注册项目 `.c0de/workflows/*.js`（project）
 * 覆盖优先级：project > user > builtin。
 */
async function createAndPopulateRegistry(projectDir: string): Promise<WorkflowRegistry> {
  const registry = createWorkflowRegistry()
  // 1. 内置（由源码字符串动态导入生成，show === run）
  for (const wf of await createBuiltinWorkflows()) {
    registry.register(wf)
  }
  // 2. 全局级（~/.c0de/workflows）
  const globalWorkflows = await discoverGlobalWorkflows()
  for (const wf of globalWorkflows) {
    registry.register(wf)
  }
  // 3. 项目级（.c0de/workflows）
  const projectWorkflows = await discoverWorkflows(projectDir)
  for (const wf of projectWorkflows) {
    registry.register(wf)
  }
  return registry
}

export type { WorkflowRegistry }
export { createAndPopulateRegistry, createWorkflowRegistry }
