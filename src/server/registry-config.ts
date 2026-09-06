// src/server/registry-config.ts
// config.providers ↔ LLM registry 的构建/同步逻辑（P1-1 从 server.ts 拆出，
// 供 chat 路由按项目配置构建注册表，避免 routes → server.ts 循环依赖）。

import { decryptSecret } from '../core/secret.js'
import {
  createRegistry,
  overrideToCapabilities,
  type Registry,
  rebuildRegistry,
  registerProvider,
} from '../llm/registry.js'
import type { Config } from '../shared/types/config.js'
import type { ProviderConfig } from '../shared/types/llm.js'

/** 把 config.providers 注册到新建的 LLM registry（修复此前空 registry 的遗漏）。 */
function buildRegistryFromConfig(config: Config): Registry {
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

export { buildRegistryFromConfig, registerProviderFromConfig, syncRegistryFromConfig }
