import type { LoopDeps } from '../core/loop.js'
import type { DB } from '../db/client.js'
import { createRegistry, registerProvider } from '../llm/index.js'
import type { Registry } from '../llm/registry.js'
import type { Config } from '../shared/types/config.js'
import type { ProviderConfig } from '../shared/types/llm.js'
import type { ToolContext, ToolDef } from '../shared/types/tool.js'
import { createDefaultRegistry } from '../tools/index.js'
import type { PermissionChecker, PermissionResult } from '../tools/types.js'

/** Print/ACP 等非交互模式：所有工具自动放行（命令由用户显式触发）。 */
const autoApproveChecker: PermissionChecker = {
  check: async (_tool: ToolDef, _input: unknown, _ctx: ToolContext): Promise<PermissionResult> => {
    return { _tag: 'allow' }
  },
  confirm: (_toolCallId: string, _approved: boolean) => {},
}

/** 把 config.providers 注册到新建的 LLM registry。 */
function buildLLMRegistry(config: Config): Registry {
  const registry = createRegistry()
  for (const p of config.providers) {
    registerProviderFromConfig(registry, p)
  }
  return registry
}

function registerProviderFromConfig(registry: Registry, p: ProviderConfig): void {
  if (!p.baseURL) return
  registerProvider(registry, { name: p.name, baseURL: p.baseURL, apiKey: p.apiKey })
}

type BuildDepsOptions = {
  db: DB
  cwd: string
  /** 测试注入 mock chatStream。 */
  chatStream?: LoopDeps['chatStream']
}

/** 组装完整 LoopDeps（auto 放行 + 默认工具注册表）。 */
async function buildAgentDeps(config: Config, opts: BuildDepsOptions): Promise<LoopDeps> {
  const deps: LoopDeps = {
    db: opts.db,
    llmRegistry: buildLLMRegistry(config),
    toolRegistry: createDefaultRegistry(),
    permission: autoApproveChecker,
    config,
    cwd: opts.cwd,
    ...(opts.chatStream ? { chatStream: opts.chatStream } : {}),
  }
  return deps
}

export type { BuildDepsOptions }
export { autoApproveChecker, buildAgentDeps, buildLLMRegistry }
