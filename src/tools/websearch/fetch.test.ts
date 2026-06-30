/**
 * websearch 代理感知 fetch 测试。
 *
 * 来源：oh-my-pi（undici ProxyAgent 包装范式），裁剪适配 c0de-agent（不调 setGlobalDispatcher，仅影响本模块）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFetch } from './fetch.js'

const ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const

// 清空所有代理变量，避免真实开发环境（HTTPS_PROXY 已设）污染测试。
beforeEach(() => {
  for (const k of ENV_KEYS) vi.stubEnv(k, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('createFetch', () => {
  it('returns global fetch when no proxy env is set', () => {
    expect(createFetch()).toBe(fetch)
  })

  it('constructs a ProxyAgent-wrapped fetch when HTTPS_PROXY is set', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890')
    const f = createFetch()
    // 不是全局 fetch（已包装）；仍可调用
    expect(f).not.toBe(fetch)
    expect(typeof f).toBe('function')
  })

  it('honors lowercase https_proxy variant', () => {
    vi.stubEnv('https_proxy', 'http://127.0.0.1:7890')
    expect(createFetch()).not.toBe(fetch)
  })

  it('honors HTTP_PROXY fallback', () => {
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:7890')
    expect(createFetch()).not.toBe(fetch)
  })
})
