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
    /** 清空注册表（热重载前调用）。 */
    clear() {
      entries.clear()
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

/**
 * 重新填充已有注册表：清空 → 三级发现 → 注册。
 * 用于 create/save 后热重载，保留同一 registry 引用。
 */
async function reloadRegistry(registry: WorkflowRegistry, projectDir: string): Promise<void> {
  registry.clear()
  for (const wf of await createBuiltinWorkflows()) {
    registry.register(wf)
  }
  for (const wf of await discoverGlobalWorkflows()) {
    registry.register(wf)
  }
  for (const wf of await discoverWorkflows(projectDir)) {
    registry.register(wf)
  }
}

export type { WorkflowRegistry }
export { createAndPopulateRegistry, createWorkflowRegistry, reloadRegistry }
