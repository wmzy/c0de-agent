/**
 * useComposerDefaults 测试：默认 provider/model 校正（P1-2）。
 * 校正规则：选择值/defaultProvider 不在已配置列表时回退首个已配置 provider；
 * 模型不在该 provider 在 config 中声明的模型清单时回退清单首项；
 * 仅在用户未操作过选择时校正（自由输入保护）；providers 列表加载中不误清持久化值。
 */

import type { Config } from '@shared/types/config.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConfig } from '@/contexts/ConfigContext.js'
import { useComposerDefaults } from '@/hooks/useComposerDefaults.js'
import type { ProviderListResponse } from '@/services/provider.js'
import { providerAPI } from '@/services/provider.js'

const SELECTION_KEY = 'c0de-agent:modelSelection'

const config: Config = {
  providers: [
    {
      name: 'anthropic',
      protocol: 'anthropic',
      apiKey: 'sk-ant',
      baseURL: 'https://api.anthropic.com',
      models: { 'claude-sonnet': {}, 'claude-opus': {} },
    },
  ],
  // 故意保留默认值：defaultProvider/defaultModel 均不在已配置列表（首跑典型形态）。
  defaultProvider: 'openai',
  defaultModel: 'gpt-4o',
  roleRouting: {},
  fallback: { enabled: false, maxRetries: 2, retryDelay: 1000 },
  compaction: { enabled: true, threshold: 0.8, reserveTokens: 1000, keepRecentTokens: 500 },
  tools: { enabled: ['*'], disabled: [] },
  plugins: { enabled: [] },
  mcpServers: [],
  slashCommands: { enabled: [] },
  toolMetrics: { enabled: true, threshold: 0.8, minSamples: 5 },
  security: { authEnabled: false, allowedOrigins: [] },
  websearch: { provider: 'auto' },
  agents: { subagentConcurrency: 3 },
  permission: { defaultMode: 'default' },
  update: { enabled: false, intervalMs: 3_600_000, initialDelayMs: 10_000 },
  usage: { monthlyBudgetUsd: 0 },
  theme: 'light',
}

vi.mock('@/services/provider.js', () => ({
  providerAPI: { list: vi.fn() },
}))

vi.mock('@/contexts/ConfigContext.js', () => ({
  useConfig: vi.fn(),
}))

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

function mockProviderList() {
  vi.mocked(providerAPI.list).mockResolvedValue({
    providers: [{ name: 'anthropic', protocol: 'anthropic', baseURL: '', hasKey: true }],
    defaultProvider: 'openai',
  })
}

beforeEach(() => {
  vi.mocked(useConfig).mockReturnValue({
    config,
    loading: false,
    refresh: vi.fn(),
    warnings: [],
    scopes: { global: null, project: null },
  })
  localStorage.clear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useComposerDefaults 默认值校正', () => {
  it('持久化 provider/model 均有效时保持原样', async () => {
    localStorage.setItem(
      SELECTION_KEY,
      JSON.stringify({ provider: 'anthropic', model: 'claude-opus' }),
    )
    mockProviderList()
    const { result } = renderHook(() => useComposerDefaults(), { wrapper: makeWrapper() })
    await waitFor(() => {
      expect(result.current.selection).toEqual({ provider: 'anthropic', model: 'claude-opus' })
    })
    // 稳定后不被覆盖
    expect(localStorage.getItem(SELECTION_KEY)).toContain('claude-opus')
  })

  it('首跑：defaultProvider/defaultModel 均不可用 → 回退首个 provider 与清单首模型', async () => {
    mockProviderList()
    const { result } = renderHook(() => useComposerDefaults(), { wrapper: makeWrapper() })
    await waitFor(() => {
      expect(result.current.selection).toEqual({ provider: 'anthropic', model: 'claude-sonnet' })
    })
    expect(localStorage.getItem(SELECTION_KEY)).toContain('claude-sonnet')
  })

  it('持久化 provider 已删除且模型不在新清单 → 回退首个 provider 与清单首模型', async () => {
    localStorage.setItem(
      SELECTION_KEY,
      JSON.stringify({ provider: 'deleted-prov', model: 'old-model' }),
    )
    mockProviderList()
    const { result } = renderHook(() => useComposerDefaults(), { wrapper: makeWrapper() })
    await waitFor(() => {
      expect(result.current.selection).toEqual({ provider: 'anthropic', model: 'claude-sonnet' })
    })
  })

  it('用户操作过的选择不再被自动校正（自由输入保护）', async () => {
    let resolveList: (v: ProviderListResponse) => void = () => {}
    vi.mocked(providerAPI.list).mockReturnValue(
      new Promise((res) => {
        resolveList = res
      }),
    )
    const { result } = renderHook(() => useComposerDefaults(), { wrapper: makeWrapper() })
    await act(async () => {}) // 列表未返回：校正跳过
    act(() => {
      result.current.setSelection({ provider: 'anthropic', model: 'custom-free-model' })
    })
    await act(async () => {
      resolveList({
        providers: [{ name: 'anthropic', protocol: 'anthropic', baseURL: '', hasKey: true }],
        defaultProvider: 'openai',
      })
    })
    await waitFor(() => {
      expect(result.current.selection).toEqual({
        provider: 'anthropic',
        model: 'custom-free-model',
      })
    })
  })

  it('providers 列表加载中不误清持久化选择', async () => {
    localStorage.setItem(
      SELECTION_KEY,
      JSON.stringify({ provider: 'anthropic', model: 'claude-opus' }),
    )
    let resolveList: (v: ProviderListResponse) => void = () => {}
    vi.mocked(providerAPI.list).mockReturnValue(
      new Promise((res) => {
        resolveList = res
      }),
    )
    const { result } = renderHook(() => useComposerDefaults(), { wrapper: makeWrapper() })
    await act(async () => {})
    expect(result.current.selection).toEqual({ provider: 'anthropic', model: 'claude-opus' })
    await act(async () => {
      resolveList({
        providers: [{ name: 'anthropic', protocol: 'anthropic', baseURL: '', hasKey: true }],
        defaultProvider: 'openai',
      })
    })
    await waitFor(() => {
      expect(result.current.selection).toEqual({ provider: 'anthropic', model: 'claude-opus' })
    })
  })
})
