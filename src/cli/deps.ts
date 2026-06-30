import type { LoopDeps } from '../core/loop.js'
import { decryptSecret } from '../core/secret.js'
import type { DB } from '../db/client.js'
import { createRegistry, registerProvider } from '../llm/index.js'
import type { Registry } from '../llm/registry.js'
import { initPlugins } from '../plugins/index.js'
import type { Config } from '../shared/types/config.js'
import type { ProviderConfig } from '../shared/types/llm.js'
import type { ToolContext, ToolDef } from '../shared/types/tool.js'
import { createDefaultRegistry, createDefaultURLRegistry } from '../tools/index.js'
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
  // 兼容 config.json 中以 _tag 标识 provider 的格式（name 缺失时回退到 _tag）
  const name = p.name || (p as { _tag?: string })._tag
  if (!name || !p.baseURL) return
  // baseURL 已含 /v1 时用 /chat/completions，避免 /v1/v1 双重前缀
  const path = p.baseURL.replace(/\/+$/, '').endsWith('/v1') ? '/chat/completions' : undefined
  registerProvider(registry, {
    name,
    baseURL: p.baseURL,
    apiKey: p.apiKey ? decryptSecret(p.apiKey) : p.apiKey,
    ...(path ? { path } : {}),
  })
}

type BuildDepsOptions = {
  db: DB
  cwd: string
  /** 测试注入 mock chatStream。 */
  chatStream?: LoopDeps['chatStream']
}

/** 组装完整 LoopDeps（auto 放行 + 默认工具注册表）。 */
async function buildAgentDeps(config: Config, opts: BuildDepsOptions): Promise<LoopDeps> {
  const llmRegistry = buildLLMRegistry(config)
  const toolRegistry = createDefaultRegistry(config)
  const { hookRunner } = await initPlugins({
    cwd: opts.cwd,
    config,
    toolRegistry,
    llmRegistry,
  })
  const deps: LoopDeps = {
    db: opts.db,
    llmRegistry,
    toolRegistry,
    urlRegistry: createDefaultURLRegistry(),
    hookRunner,
    permission: autoApproveChecker,
    config,
    cwd: opts.cwd,
    ...(opts.chatStream ? { chatStream: opts.chatStream } : {}),
  }
  return deps
}

export type { BuildDepsOptions }
export { autoApproveChecker, buildAgentDeps, buildLLMRegistry }
