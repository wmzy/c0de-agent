import type { LoopDeps } from '../core/loop.js'
import { decryptSecret } from '../core/secret.js'
import type { DB } from '../db/client.js'
import { createRegistry, overrideToCapabilities, registerProvider } from '../llm/index.js'
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

/**
 * 非交互模式（print）安全策略（P1-6）：ask 工具**直接拒绝**并给出可操作提示
 * （-y 或 serve），而非返回 permission_required 让 LLM 在无确认通道下无限重试。
 * 拒绝原因作为 tool result 交给模型，模型会向用户转述。
 */
const nonInteractiveSafeChecker: PermissionChecker = {
  check: async (tool: ToolDef, _input: unknown, _ctx: ToolContext): Promise<PermissionResult> => {
    const result = await autoAllowChecker.check(tool, _input, _ctx)
    if (result._tag === 'ask') {
      return {
        _tag: 'deny',
        reason: `非交互模式：工具 "${tool.name}" 需要确认。请加 -y 放行写操作，或使用 c0de serve 交互确认`,
      }
    }
    return result
  },
  confirm: autoAllowChecker.confirm,
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
    // 传递用户配置的 per-model capabilities（contextWindow 等），
    // 否则 resolveRoute 回退到 DEFAULT_MODEL_CAPABILITIES，可能导致预算过小。
    ...(p.models ? { models: overrideToCapabilities(p.models) } : {}),
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
  if (strategy === 'safe') return nonInteractiveSafeChecker
  return config.permission.defaultMode === 'auto'
    ? fullyAutoApproveChecker
    : nonInteractiveSafeChecker
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
export { buildAgentDeps, buildLLMRegistry, fullyAutoApproveChecker, nonInteractiveSafeChecker }
