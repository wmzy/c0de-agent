/**
 * ModelSelector 组件测试，对应 src/web/components/ModelSelector.tsx。
 * 验证 model 建议项（自定义弹出列表）来自 config.providers[当前provider].models，
 * 且 enabled:false 的模型不出现。
 * 自定义列表替代原生 datalist，避免后者在 input 有值时按值过滤掉其他选项。
 */

import type { Config } from '@shared/types/config.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useConfig } from '../contexts/ConfigContext.js'
import { providerAPI } from '../services/provider.js'
import { type ModelSelection, ModelSelector } from './ModelSelector.js'

const baseConfig: Config = {
  providers: [
    {
      name: 'sensenova',
      protocol: 'openai-compat',
      apiKey: 'sk-xxx',
      baseURL: 'https://api.sensenova.cn/compatible-mode/v1',
      models: {
        'SenseChat-5': {},
        'SenseChat-Vision': { enabled: true },
        'SenseChat-Reasoning': { enabled: false },
      },
    },
    {
      name: 'openai',
      protocol: 'openai',
      apiKey: 'sk-oai',
      baseURL: 'https://api.openai.com/v1',
      models: { 'gpt-4o': {} },
    },
  ],
  defaultProvider: 'sensenova',
  defaultModel: 'SenseChat-5',
  roleRouting: {},
  fallback: { enabled: false, maxRetries: 2, retryDelay: 1000 },
  compaction: { enabled: true, threshold: 0.8, reserveTokens: 1000, keepRecentTokens: 500 },
  tools: { enabled: [], disabled: [] },
  plugins: { enabled: [] },
  mcpServers: [],
  slashCommands: { enabled: [] },
  toolMetrics: { enabled: true, threshold: 0.8, minSamples: 5 },
  security: { authEnabled: false, allowedOrigins: [] },
  theme: 'light',
  locale: 'zh-CN',
}

vi.mock('../services/provider.js', () => ({
  providerAPI: { list: vi.fn() },
}))

vi.mock('../contexts/ConfigContext.js', () => ({
  useConfig: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderSelector(value: ModelSelection, config: Config = baseConfig) {
  vi.mocked(useConfig).mockReturnValue({ config, loading: false, refresh: vi.fn() })
  vi.mocked(providerAPI.list).mockResolvedValue({
    providers: config.providers.map((p) => ({
      name: p.name,
      protocol: p.protocol,
      baseURL: p.baseURL ?? '',
      hasKey: !!p.apiKey,
    })),
    defaultProvider: config.defaultProvider,
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ModelSelector value={value} onChange={vi.fn()} />
    </QueryClientProvider>,
  )
}

/** 打开 model 下拉并返回列表项文本。 */
function hints() {
  const btn = document.querySelector('[data-testid="model-dropdown"]')
  if (btn) fireEvent.click(btn)
  const list = document.querySelector('[data-testid="model-hints"]')
  if (!list) return []
  return Array.from(list.querySelectorAll('button')).map((b) => b.textContent || '')
}

describe('ModelSelector — model 建议项', () => {
  it('仅展示当前 provider 启用的模型（enabled 省略/true 视为启用）', () => {
    renderSelector({ provider: 'sensenova', model: '' })
    // 3 个模型里 SenseChat-Reasoning 被 enabled:false 过滤掉
    expect(hints()).toEqual(['SenseChat-5', 'SenseChat-Vision'])
  })

  it('切换 provider 后建议项跟随该 provider 的模型', () => {
    renderSelector({ provider: 'openai', model: '' })
    expect(hints()).toEqual(['gpt-4o'])
  })

  it('当前 provider 无 models 时不渲染下拉', () => {
    const cfg: Config = {
      ...baseConfig,
      providers: [{ name: 'plain', protocol: 'openai-compat', apiKey: 'k', baseURL: '' }],
    }
    renderSelector({ provider: 'plain', model: '' }, cfg)
    expect(document.querySelector('[data-testid="model-dropdown"]')).toBeNull()
  })

  // 回归：原生 <datalist> 在 input 有值时会按该值过滤选项，导致已填入
  // defaultModel 时只显示 1 个匹配项。自定义列表必须始终展示全部启用模型。
  it('input 已有值时下拉仍显示全部启用模型（不过滤）', () => {
    renderSelector({ provider: 'sensenova', model: 'SenseChat-5' })
    expect(hints()).toEqual(['SenseChat-5', 'SenseChat-Vision'])
  })
})
