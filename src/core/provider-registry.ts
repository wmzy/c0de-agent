// config.providers ↔ LLM registry 的构建/同步逻辑（单一权威实现）。
//
// 此前 server/registry-config.ts 与 cli/deps.ts 各持一份 registerProviderFromConfig：
// server 版带「畸形条目跳过」守卫（读取侧自愈兜底），CLI 版没有——手改/旧版
// config.json 里的畸形条目（null 条目、baseURL 非字符串）在 CLI 路径上让
// `p.name` / `p.baseURL.replace` 抛 TypeError，而 buildAgentDeps 无 try/catch：
// c0de chat / print / acp 启动即崩溃（server 路径因守卫而幸免）。
// 收敛到本模块：server 路由 / CLI deps 共用同一实现，杜绝再次漂移。

import {
  createRegistry,
  overrideToCapabilities,
  type Registry,
  rebuildRegistry,
  registerProvider,
  resolveRoute,
} from '../llm/registry.js'
import type { Config } from '../shared/types/config.js'
import type { ProviderConfig } from '../shared/types/llm.js'
import { decryptSecretSafe } from './secret.js'

/** 注册单个 provider 配置条目（畸形/不可解条目静默跳过，绝不抛错）。
 *
 * 跳过而非击穿的理由：
 *  - 手改/旧版配置文件可能携带畸形条目（null/字符串/数组等）：读取侧自愈兜底，
 *    否则保存接口 500（syncRegistryFromConfig）或服务/CLI 无法启动。
 *  - 机器绑定密文换机后不可解（enc: 前缀的 apiKey 跨机同步/容器重建）：跳过该
 *    provider 并告警，而非上抛击穿启动/请求路径——密文本就不可跨机解密。
 */
function registerProviderFromConfig(registry: Registry, p: ProviderConfig): void {
  // 写入侧（applyScopedPatch 的 assertValidProviderList）已显式拒绝畸形条目，
  // 此处是读取侧的自愈兜底。
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return
  // 兼容 config.json 中以 _tag 标识 provider 的格式（name 缺失时回退到 _tag）
  const name = p.name || (p as { _tag?: string })._tag
  if (!name || typeof p.baseURL !== 'string' || !p.baseURL) return
  const apiKey = typeof p.apiKey === 'string' && p.apiKey ? decryptSecretSafe(p.apiKey) : p.apiKey
  if (p.apiKey && apiKey === undefined) {
    console.warn(
      `provider "${name}" 的 apiKey 无法在本机解密（配置来自其他机器或密文损坏），已跳过注册，请重新设置`,
    )
    return
  }
  // baseURL 已含 /v1 时用 /chat/completions，避免 /v1/v1 双重前缀
  const path = p.baseURL.replace(/\/+$/, '').endsWith('/v1') ? '/chat/completions' : undefined
  registerProvider(registry, {
    name,
    baseURL: p.baseURL,
    apiKey: apiKey ?? p.apiKey ?? '',
    ...(path ? { path } : {}),
    // 传递用户配置的 per-model capabilities（contextWindow 等），
    // 否则 resolveRoute 回退到 DEFAULT_MODEL_CAPABILITIES，可能导致预算过小。
    ...(p.models ? { models: overrideToCapabilities(p.models) } : {}),
  })
}

/** 把 config.providers 注册到新建的 LLM registry（server 启动与 CLI deps 共用）。 */
function buildRegistryFromConfig(config: Config): Registry {
  const registry = createRegistry()
  for (const p of config.providers) {
    registerProviderFromConfig(registry, p)
  }
  return registry
}

/**
 * config 变更后原子地同步 registry：在隔离的 next registry 上重建全部路由，
 * 完成后一次性替换 registry 内部 table 引用。运行中的 resolveRoute 任何时刻
 * 看到的都是完整的旧表或完整的新表，不会读到「已清空但未注册完」的半状态，
 * 因此不会把本可用的 provider 误判为 NoRoute。ServerContext 立即生效，无需重启。
 */
function syncRegistryFromConfig(registry: Registry, config: Config): void {
  rebuildRegistry(registry, (next) => {
    for (const p of config.providers) {
      registerProviderFromConfig(next, p)
    }
  })
}

/** provider/model 运行前预检结果（判别联合）：
 *  - ok：路由可解析，且（provider 声明了模型清单时）请求模型在清单内；
 *  - no-providers：配置完全没有 provider 条目 → 首跑引导添加；
 *  - provider-not-found：路由解析失败但已有配置（大概率拼写错误）→ 列已配置名；
 *  - model-not-found：provider 显式声明了模型清单但请求模型不在其中。
 *   未声明清单的 provider（自建网关等）接受任意模型名，不做校验。 */
type RoutePreflight =
  | { ok: true }
  | {
      ok: false
      reason: 'no-providers' | 'provider-not-found'
      provider: string
      /** 已配置 provider 名单（畸形/无名条目剔除），供错误文案与 details。 */
      configured: string[]
    }
  | {
      ok: false
      reason: 'model-not-found'
      provider: string
      model: string
      knownModels: string[]
    }

/** provider/model 运行前预检（server 聊天路由与 CLI print 共用的单点实现）。
 *
 * 此前两份内联实现已漂移：Web 版 provider 条目查找兼容 `_tag` 标识
 * （name 缺失时回退，与 registerProviderFromConfig 注册口径一致），CLI 版
 * 只比 name——同一份配置在两端判定不同。收敛后统一按注册口径查找。 */
function preflightRoute(
  registry: Registry,
  providers: ProviderConfig[],
  provider: string,
  model: string,
): RoutePreflight {
  // 读取侧自愈兜底：手改/旧版配置可能携带畸形条目（null/非对象），剔除后再判
  const entries = providers.filter((p): p is ProviderConfig => p != null && typeof p === 'object')
  try {
    resolveRoute(registry, provider, model)
  } catch {
    if (entries.length === 0) {
      return { ok: false, reason: 'no-providers', provider, configured: [] }
    }
    return {
      ok: false,
      reason: 'provider-not-found',
      provider,
      configured: entries.map((p) => p.name).filter(Boolean),
    }
  }
  const providerDef = entries.find((p) => (p.name || (p as { _tag?: string })._tag) === provider)
  const modelNames = providerDef?.models ? Object.keys(providerDef.models) : undefined
  if (modelNames && modelNames.length > 0 && !modelNames.includes(model)) {
    return { ok: false, reason: 'model-not-found', provider, model, knownModels: modelNames }
  }
  return { ok: true }
}

export {
  buildRegistryFromConfig,
  preflightRoute,
  registerProviderFromConfig,
  syncRegistryFromConfig,
}
