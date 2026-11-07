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

type RegistryPopulateOptions = {
  /**
   * 项目是否当前可信任（P0 信任边界）：false 时跳过项目级
   * `.c0de/workflows/*.js` 发现（不 dynamic import 仓库代码）。
   * 缺省为 false——调用方必须显式确认信任后才放行（fail-closed）。
   * 内置与全局 `~/.c0de/workflows` 是用户本机显式安装，始终加载。
   */
  projectTrusted?: boolean
}

/** 三级发现填充循环（builtin → global → project-if-trusted），后注册覆盖同名。
 *  createAndPopulateRegistry 与 reloadRegistry 共用；两个入口的差异仅在
 *  「新建 registry」还是「清空既有 registry」。 */
async function populateRegistry(
  registry: WorkflowRegistry,
  projectDir: string,
  opts: RegistryPopulateOptions = {},
): Promise<void> {
  // 1. 内置（由源码字符串动态导入生成，show === run）
  for (const wf of await createBuiltinWorkflows()) {
    registry.register(wf)
  }
  // 2. 全局级（~/.c0de/workflows）
  for (const wf of await discoverGlobalWorkflows()) {
    registry.register(wf)
  }
  // 3. 项目级（.c0de/workflows）——未信任项目绝不 import（任意代码执行面）
  if (opts.projectTrusted) {
    for (const wf of await discoverWorkflows(projectDir)) {
      registry.register(wf)
    }
  }
}

/**
 * 创建并填充工作流注册表（三级发现，后注册覆盖同名）：
 *  1. 注册内置工作流（builtin）
 *  2. 发现并注册全局 `~/.c0de/workflows/*.js`（user）
 *  3. 发现并注册项目 `.c0de/workflows/*.js`（project；仅 projectTrusted 时）
 * 覆盖优先级：project > user > builtin。
 */
async function createAndPopulateRegistry(
  projectDir: string,
  opts: RegistryPopulateOptions = {},
): Promise<WorkflowRegistry> {
  const registry = createWorkflowRegistry()
  await populateRegistry(registry, projectDir, opts)
  return registry
}

/**
 * 重新填充已有注册表：清空 → 三级发现 → 注册。
 * 用于 create/save 后热重载，保留同一 registry 引用。
 * 项目级发现同样受 projectTrusted 门禁（fail-closed）。
 */
async function reloadRegistry(
  registry: WorkflowRegistry,
  projectDir: string,
  opts: RegistryPopulateOptions = {},
): Promise<void> {
  registry.clear()
  await populateRegistry(registry, projectDir, opts)
}

export type { WorkflowRegistry }
export { createAndPopulateRegistry, createWorkflowRegistry, reloadRegistry }
