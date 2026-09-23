// provider-registry：config.providers ↔ LLM registry 的构建/同步（单一权威实现，
// server 启动/路由与 CLI deps 共用）。
// 复现 1：机器绑定密文（apiKey enc: 前缀）跨机同步/损坏后，buildRegistryFromConfig
// 直接上抛解密异常——serve 启动（bootstrapServerContext）与配置保存（sync）崩溃。
// 复现 2：手改/旧版 config.json 的畸形条目（null 条目、baseURL 非字符串）此前只在
// server 侧的旧副本有守卫——CLI 侧副本（cli/deps.ts）无守卫，启动即 TypeError。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveRoute } from '../llm/registry.js'
import type { Config } from '../shared/types/config.js'
import { DEFAULT_CONFIG } from './config.js'
import { buildRegistryFromConfig } from './provider-registry.js'
import { encryptSecret } from './secret.js'

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

describe('buildRegistryFromConfig — 畸形条目读取侧自愈', () => {
  it('null 条目与 baseURL 非字符串条目被跳过，不抛错且不波及正常 provider', () => {
    const config = {
      ...configWithProvider('sk-plain'),
      providers: [
        null,
        { name: 'bad-url', protocol: 'openai', apiKey: 'k', baseURL: 42 },
        {
          name: 'demo',
          protocol: 'openai',
          apiKey: 'sk-plain',
          baseURL: 'https://demo.example/v1',
        },
      ],
    } as unknown as Config
    const registry = buildRegistryFromConfig(config)
    // 正常条目仍注册（跳过畸形不得波及）
    expect(resolveRoute(registry, 'demo', 'demo-model').route.auth.apiKey).toBe('sk-plain')
  })

  it('baseURL 缺失/空串的条目被跳过', () => {
    const config = {
      ...configWithProvider('sk-plain'),
      providers: [
        { name: 'no-url', protocol: 'openai', apiKey: 'k' },
        { name: 'empty-url', protocol: 'openai', apiKey: 'k', baseURL: '' },
      ],
    } as unknown as Config
    expect(() => buildRegistryFromConfig(config)).not.toThrow()
  })
})
