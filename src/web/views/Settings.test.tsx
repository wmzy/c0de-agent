/**
 * Settings 视图测试，对应 src/web/views/Settings.tsx。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Mock } from 'vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Settings } from './Settings.js'

const mockConfig = {
  providers: [
    {
      name: 'ProviderA',
      protocol: 'openai',
      apiKey: 'sk-xxx',
      baseURL: 'https://api.openai.com/v1',
    },
    {
      name: 'ProviderB',
      protocol: 'anthropic',
      apiKey: 'sk-anthropic',
      baseURL: 'https://api.anthropic.com',
    },
  ],
  defaultProvider: 'ProviderA',
  defaultModel: 'gpt-4',
  roleRouting: {},
  fallback: { enabled: false, maxRetries: 2, retryDelay: 1000 },
  compaction: {
    enabled: true,
    threshold: 0.8,
    reserveTokens: 1000,
    keepRecentTokens: 500,
  },
  tools: { enabled: ['bash', 'read'], disabled: [] },
  plugins: { enabled: [] },
  mcpServers: [],
  slashCommands: { enabled: [] },
  theme: 'light',
  locale: 'zh-CN',
}

vi.mock('../services/config.js', () => ({
  configAPI: {
    get: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('../services/provider.js', () => ({
  providerAPI: {
    test: vi.fn(),
  },
}))

// ProviderCatalogDialog 依赖 catalog service，mock 掉避免测试中发起网络请求
vi.mock('../services/catalog.js', () => ({
  catalogAPI: {
    listProviders: vi.fn(),
    getProviderModels: vi.fn(),
    search: vi.fn(),
    refresh: vi.fn(),
  },
}))

vi.mock('../contexts/ThemeContext.js', () => ({
  useTheme: () => ({ mode: 'light', setMode: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderSettings() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  return render(
    <QueryClientProvider client={qc}>
      <Settings />
    </QueryClientProvider>,
  )
}

describe('Settings — Provider 管理', () => {
  it('渲染时显示已加载 config 的 providers', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)

    renderSettings()

    await waitFor(() => {
      expect(screen.getAllByTestId('provider-row')).toHaveLength(2)
    })
    // 限定到 provider-row 内查找 name 输入框，避免与 defaultProvider 文本框冲突
    const rows = screen.getAllByTestId('provider-row')
    expect(within(rows[0] as HTMLElement).getByDisplayValue('ProviderA')).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByDisplayValue('ProviderB')).toBeTruthy()
    expect(
      within(rows[0] as HTMLElement).getByDisplayValue('https://api.openai.com/v1'),
    ).toBeTruthy()
    expect(
      within(rows[1] as HTMLElement).getByDisplayValue('https://api.anthropic.com'),
    ).toBeTruthy()
  })

  it('点击「添加 Provider」新增一行', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)

    renderSettings()

    await waitFor(() => {
      expect(screen.getByTestId('provider-add')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('provider-add'))

    const rows = screen.getAllByTestId('provider-row')
    expect(rows).toHaveLength(3)
  })

  it('点击「测试」调用 providerAPI.test 并显示成功结果', async () => {
    const { configAPI } = await import('../services/config.js')
    const { providerAPI } = await import('../services/provider.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)
    ;(providerAPI.test as Mock).mockResolvedValue({
      ok: true,
      models: ['gpt-4', 'gpt-4o', 'claude-3'],
    })

    renderSettings()

    await waitFor(() => {
      expect(screen.getAllByTestId('provider-test')).toHaveLength(2)
    })

    // 测试第一个 provider
    fireEvent.click(screen.getAllByTestId('provider-test')[0] as HTMLElement)

    await waitFor(() => {
      expect(providerAPI.test).toHaveBeenCalledWith('https://api.openai.com/v1', 'sk-xxx')
    })
    await waitFor(() => {
      expect(screen.getByText('✓ 连接成功，3 个模型')).toBeTruthy()
    })
  })

  it('点击「删除」移除一行', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)

    renderSettings()

    await waitFor(() => {
      expect(screen.getAllByTestId('provider-row')).toHaveLength(2)
    })

    // 删除第一行
    fireEvent.click(screen.getAllByTestId('provider-remove')[0] as HTMLElement)

    const rows = screen.getAllByTestId('provider-row')
    expect(rows).toHaveLength(1)
    // 仅在剩余 provider-row 内检查 ProviderA 已被删除
    const remaining = within(rows[0] as HTMLElement)
    expect(remaining.queryByDisplayValue('ProviderA')).toBeNull()
    expect(remaining.getByDisplayValue('ProviderB')).toBeTruthy()
  })

  it('点击「从 models.dev 选择」打开 catalog 弹窗', async () => {
    const { configAPI } = await import('../services/config.js')
    const { catalogAPI } = await import('../services/catalog.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)
    ;(catalogAPI.listProviders as Mock).mockResolvedValue({ providers: [] })

    renderSettings()

    await waitFor(() => {
      expect(screen.getByTestId('provider-catalog')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('provider-catalog'))

    await waitFor(() => {
      expect(screen.getByTestId('provider-catalog-dialog')).toBeTruthy()
    })
  })

  it('点击「保存」调用 configAPI.update 并带 providers', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()

    // 先等加载完成
    await waitFor(() => {
      expect(screen.getByTestId('provider-add')).toBeTruthy()
    })

    // 添加一个 provider 使 draft 不为 null（保存按钮才能启用）
    fireEvent.click(screen.getByTestId('provider-add'))

    // 修改新 provider 的 name 字段
    const nameInputs = screen.getAllByPlaceholderText('名称')
    fireEvent.change(nameInputs[nameInputs.length - 1] as HTMLElement, {
      target: { value: 'MyProvider' },
    })

    // 点击保存
    const saveBtn = screen.getByTestId('settings-save')
    expect(saveBtn).not.toBeDisabled()
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(configAPI.update).toHaveBeenCalled()
    })

    const updateCallArgs = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      providers: { name: string }[]
    }
    expect(updateCallArgs.providers).toHaveLength(3)
    expect(updateCallArgs.providers.at(2)?.name).toBe('MyProvider')
  })

  it('测试成功后将检测到的模型写入 provider.models，保存时一并提交', async () => {
    const { configAPI } = await import('../services/config.js')
    const { providerAPI } = await import('../services/provider.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)
    ;(providerAPI.test as Mock).mockResolvedValue({
      ok: true,
      models: ['gpt-4', 'gpt-4o', 'gpt-4o-mini'],
    })

    renderSettings()

    await waitFor(() => {
      expect(screen.getAllByTestId('provider-test')).toHaveLength(2)
    })

    // 测试第一个 provider（ProviderA，未预设 models）
    fireEvent.click(screen.getAllByTestId('provider-test')[0] as HTMLElement)

    await waitFor(() => {
      expect(screen.getByText('✓ 连接成功，3 个模型')).toBeTruthy()
    })

    // 测试成功已使 draft 非空，保存按钮启用
    fireEvent.click(screen.getByTestId('settings-save'))

    await waitFor(() => {
      expect(configAPI.update).toHaveBeenCalled()
    })

    const updateCallArgs = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      providers: { name: string; models?: Record<string, unknown> }[]
    }
    const providerA = updateCallArgs.providers.find((p) => p.name === 'ProviderA')
    expect(providerA?.models).toBeTruthy()
    expect(Object.keys(providerA?.models ?? {})).toEqual(
      expect.arrayContaining(['gpt-4', 'gpt-4o', 'gpt-4o-mini']),
    )
  })

  it('测试成功时保留 provider 已有的 models override，仅补全新模型', async () => {
    const { configAPI } = await import('../services/config.js')
    const { providerAPI } = await import('../services/provider.js')
    // ProviderA 已预设一个带 override 的模型
    ;(configAPI.get as Mock).mockResolvedValue({
      ...mockConfig,
      providers: [
        {
          name: 'ProviderA',
          protocol: 'openai',
          apiKey: 'sk-xxx',
          baseURL: 'https://api.openai.com/v1',
          models: { 'gpt-4': { contextWindow: 8192 } },
        },
        mockConfig.providers[1],
      ],
    })
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)
    ;(providerAPI.test as Mock).mockResolvedValue({
      ok: true,
      models: ['gpt-4', 'gpt-4o'],
    })

    renderSettings()

    await waitFor(() => {
      expect(screen.getAllByTestId('provider-test')).toHaveLength(2)
    })

    fireEvent.click(screen.getAllByTestId('provider-test')[0] as HTMLElement)

    await waitFor(() => {
      expect(screen.getByText('✓ 连接成功，2 个模型')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('settings-save'))

    await waitFor(() => {
      expect(configAPI.update).toHaveBeenCalled()
    })

    const updateCallArgs = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      providers: {
        name: string
        models?: Record<string, { contextWindow?: number }>
      }[]
    }
    const providerA = updateCallArgs.providers.find((p) => p.name === 'ProviderA')
    // 旧 override 被保留
    expect(providerA?.models?.['gpt-4']?.contextWindow).toBe(8192)
    // 新检测到的模型被补全
    expect(providerA?.models?.['gpt-4o']).toBeDefined()
  })

  // ---- 模型管理面板（展示/过滤/启禁）----
  const configWithModels = {
    ...mockConfig,
    providers: [
      {
        name: 'ProviderA',
        protocol: 'openai',
        apiKey: 'sk-xxx',
        baseURL: 'https://api.openai.com/v1',
        models: {
          'gpt-4': {},
          'gpt-4o': { enabled: true },
          'gpt-4o-mini': { enabled: false },
        },
      },
      mockConfig.providers[1],
    ],
  }

  it('provider 含 models 时展示模型管理面板与计数', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(configWithModels)

    renderSettings()

    await waitFor(() => {
      expect(screen.getAllByTestId('provider-row')).toHaveLength(2)
    })

    const rows = screen.getAllByTestId('provider-row')
    const panel = within(rows[0] as HTMLElement).getByTestId('provider-models') as HTMLElement
    expect(within(panel).getByText('2 / 3 已启用')).toBeTruthy()
    expect(within(panel).getAllByRole('checkbox')).toHaveLength(3)
    expect(
      within(panel).getByTestId('provider-model-toggle-gpt-4o-mini') as HTMLInputElement,
    ).not.toBeChecked()
  })

  it('过滤输入框按模型名筛选列表', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(configWithModels)

    renderSettings()

    await waitFor(() => {
      expect(screen.getAllByTestId('provider-row')).toHaveLength(2)
    })

    const rows = screen.getAllByTestId('provider-row')
    const panel = within(rows[0] as HTMLElement).getByTestId('provider-models') as HTMLElement

    fireEvent.change(within(panel).getByTestId('provider-model-filter'), {
      target: { value: '4o' },
    })

    // 仅剩 gpt-4o 和 gpt-4o-mini
    expect(within(panel).getAllByRole('checkbox')).toHaveLength(2)
    expect(within(panel).getByTestId('provider-model-toggle-gpt-4o')).toBeTruthy()
    expect(within(panel).queryByTestId('provider-model-toggle-gpt-4')).toBeNull()
  })

  it('切换单个模型开关翻转其启用状态与计数', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(configWithModels)

    renderSettings()

    await waitFor(() => {
      expect(screen.getAllByTestId('provider-row')).toHaveLength(2)
    })

    const rows = screen.getAllByTestId('provider-row')
    const panel = within(rows[0] as HTMLElement).getByTestId('provider-models') as HTMLElement
    const miniToggle = within(panel).getByTestId(
      'provider-model-toggle-gpt-4o-mini',
    ) as HTMLInputElement

    expect(miniToggle).not.toBeChecked()
    fireEvent.click(miniToggle)

    expect(miniToggle).toBeChecked()
    expect(within(panel).getByText('3 / 3 已启用')).toBeTruthy()
  })

  it('禁用所有将全部模型标记 enabled:false 并随保存提交', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(configWithModels)
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()

    await waitFor(() => {
      expect(screen.getAllByTestId('provider-row')).toHaveLength(2)
    })

    const rows = screen.getAllByTestId('provider-row')
    const panel = within(rows[0] as HTMLElement).getByTestId('provider-models') as HTMLElement

    fireEvent.click(within(panel).getByTestId('provider-models-disable-all'))
    expect(within(panel).getByText('0 / 3 已启用')).toBeTruthy()

    fireEvent.click(screen.getByTestId('settings-save'))

    await waitFor(() => {
      expect(configAPI.update).toHaveBeenCalled()
    })

    const updateArgs = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      providers: { name: string; models?: Record<string, { enabled?: boolean }> }[]
    }
    const providerA = updateArgs.providers.find((p) => p.name === 'ProviderA')
    expect(Object.values(providerA?.models ?? {}).every((m) => m.enabled === false)).toBe(true)
  })

  it('启用所有恢复全部模型为启用', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(configWithModels)

    renderSettings()

    await waitFor(() => {
      expect(screen.getAllByTestId('provider-row')).toHaveLength(2)
    })

    const rows = screen.getAllByTestId('provider-row')
    const panel = within(rows[0] as HTMLElement).getByTestId('provider-models') as HTMLElement

    fireEvent.click(within(panel).getByTestId('provider-models-enable-all'))

    expect(within(panel).getByText('3 / 3 已启用')).toBeTruthy()
    expect(
      within(panel).getByTestId('provider-model-toggle-gpt-4o-mini') as HTMLInputElement,
    ).toBeChecked()
  })
})
