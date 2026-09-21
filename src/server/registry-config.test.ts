// registry-config：config.providers ↔ LLM registry 的构建/同步。
// 复现：机器绑定密文（apiKey enc: 前缀）跨机同步/损坏后，buildRegistryFromConfig
// 直接上抛解密异常——serve 启动（bootstrapServerContext）与配置保存（sync）崩溃。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../core/config.js'
import { encryptSecret } from '../core/secret.js'
import { resolveRoute } from '../llm/registry.js'
import type { Config } from '../shared/types/config.js'
import { buildRegistryFromConfig } from './registry-config.js'

/** 构造带单个 provider 的配置；apiKey 由调用方提供。 */
function configWithProvider(apiKey: string): Config {
  return {
    ...DEFAULT_CONFIG,
    providers: [{ name: 'demo', protocol: 'openai', apiKey, baseURL: 'https://demo.example/v1' }],
  }
}

describe('buildRegistryFromConfig — 跨机密文兜底', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('本机可解密的 enc: apiKey 正常注册且解密透传', () => {
    const registry = buildRegistryFromConfig(configWithProvider(encryptSecret('sk-local')))
    const resolved = resolveRoute(registry, 'demo', 'demo-model')
    expect(resolved.route.auth.apiKey).toBe('sk-local')
  })

  it('无法解密的 enc: apiKey → 跳过该 provider 并告警，而非上抛击穿调用方', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 密文在「其他机器」加密：本机密钥派生必然 GCM 校验失败。
    const foreign = `enc:${Buffer.from(Array.from({ length: 48 }, (_, i) => i)).toString('base64')}`
    const registry = buildRegistryFromConfig(configWithProvider(foreign))
    // 不注册悬空路由：resolveRoute 明确 NoRoute，而非 401 假可用。
    expect(() => resolveRoute(registry, 'demo', 'demo-model')).toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('明文 apiKey（无前缀，向后兼容）照常注册', () => {
    const registry = buildRegistryFromConfig(configWithProvider('sk-plain'))
    expect(resolveRoute(registry, 'demo', 'demo-model').route.auth.apiKey).toBe('sk-plain')
  })
})
