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
import { autoAllowChecker } from '../tools/permission.js'
import type { PermissionChecker, PermissionResult } from '../tools/types.js'

/** 权限策略：
 * - 'full-auto'：所有工具无条件放行（print/acp 等非交互模式）。
 * - 'safe'（默认）：只读工具放行，写/执行工具需确认（chat 等 agent 自主执行场景）。 */
type PermissionStrategy = 'full-auto' | 'safe'

/** 真正非交互模式（print/acp）：所有工具无条件放行（命令由用户显式触发）。 */
const fullyAutoApproveChecker: PermissionChecker = {
  check: async (_tool: ToolDef, _input: unknown, _ctx: ToolContext): Promise<PermissionResult> => {
    return { _tag: 'allow' }
  },
  confirm: (_toolCallId: string, _approved: boolean) => {},
}

/** 安全策略：只读工具（permission: 'auto'，如 read/grep/glob/websearch）自动放行；
 * 写/执行工具（permission: 'ask'，如 bash/write/edit）返回 ask 需确认；
 * permission: 'deny' 拒绝。复用 tools 层 autoAllowChecker（按工具自身声明的权限分级）。 */
const readOnlySafeChecker: PermissionChecker = autoAllowChecker

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
  /** 权限策略：'full-auto' 全部放行；'safe' 只读放行、写操作 ask。不传时按
   * config.permission.defaultMode 决定（'auto'→full-auto，'default'→safe）。 */
  permissionStrategy?: PermissionStrategy
  /** 测试注入 mock chatStream。 */
  chatStream?: LoopDeps['chatStream']
}

/** 解析权限 checker：显式策略优先，否则回退到 config.permission.defaultMode。 */
function resolvePermissionChecker(
  config: Config,
  strategy?: PermissionStrategy,
): PermissionChecker {
  if (strategy === 'full-auto') return fullyAutoApproveChecker
  if (strategy === 'safe') return readOnlySafeChecker
  return config.permission.defaultMode === 'auto' ? fullyAutoApproveChecker : readOnlySafeChecker
}

/** 组装完整 LoopDeps（默认 safe 放行 + 默认工具注册表）。 */
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
    permission: resolvePermissionChecker(config, opts.permissionStrategy),
    config,
    cwd: opts.cwd,
    ...(opts.chatStream ? { chatStream: opts.chatStream } : {}),
  }
  return deps
}

export type { BuildDepsOptions, PermissionStrategy }
export { buildAgentDeps, buildLLMRegistry, fullyAutoApproveChecker, readOnlySafeChecker }
