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
  toolMetrics: { enabled: true, threshold: 0.8, minSamples: 5 },
  security: { authEnabled: false, allowedOrigins: [] },
  websearch: { provider: 'auto' },
  agents: { dir: '.c0de/agents', subagentConcurrency: 3 },
  permission: { defaultMode: 'default' },
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

  it('编辑模型的上下文窗口/最大输出后随保存提交', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(configWithModels)
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()

    await waitFor(() => {
      expect(screen.getAllByTestId('provider-row')).toHaveLength(2)
    })

    const rows = screen.getAllByTestId('provider-row')
    const panel = within(rows[0] as HTMLElement).getByTestId('provider-models') as HTMLElement

    // 给 gpt-4o 设置 contextWindow 和 maxOutput
    const ctxInput = within(panel).getByTestId('model-ctx-gpt-4o') as HTMLInputElement
    fireEvent.change(ctxInput, { target: { value: '1000000' } })
    const outputInput = within(panel).getByTestId('model-output-gpt-4o') as HTMLInputElement
    fireEvent.change(outputInput, { target: { value: '8192' } })

    fireEvent.click(screen.getByTestId('settings-save'))

    await waitFor(() => {
      expect(configAPI.update).toHaveBeenCalled()
    })

    const updateArgs = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      providers: {
        name: string
        models?: Record<string, { contextWindow?: number; maxOutput?: number }>
      }[]
    }
    const providerA = updateArgs.providers.find((p) => p.name === 'ProviderA')
    expect(providerA?.models?.['gpt-4o']?.contextWindow).toBe(1_000_000)
    expect(providerA?.models?.['gpt-4o']?.maxOutput).toBe(8192)
  })

  it('编辑 provider name 不会重新挂载输入行（避免输入一个字符即失焦）', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)

    renderSettings()

    await waitFor(() => {
      expect(screen.getAllByTestId('provider-row')).toHaveLength(2)
    })

    // 持有第一个 provider 的 name 输入框 DOM 引用
    const rows = screen.getAllByTestId('provider-row')
    const nameInput = within(rows[0] as HTMLElement).getByPlaceholderText(
      '名称',
    ) as HTMLInputElement
    expect(nameInput.value).toBe('ProviderA')

    // 输入会改变 provider.name —— 若 key 依赖 name，此处会卸载重建该行，DOM 节点改变
    fireEvent.change(nameInput, { target: { value: 'ProviderAX' } })

    // 重新查询：必须是同一个 DOM 节点（否则即重挂载，实际表现为输入失焦）
    const rowsAfter = screen.getAllByTestId('provider-row')
    const nameInputAgain = within(rowsAfter[0] as HTMLElement).getByPlaceholderText('名称')
    expect(nameInputAgain).toBe(nameInput)
    expect((nameInputAgain as HTMLInputElement).value).toBe('ProviderAX')
  })

  // 回归：保存后 apiKey 落盘为 enc: 密文，刷新后 Settings 不应把密文回显到输入框
  // （否则用户误以为「key 没保存」）。应留空并显示「已加密」徽章。
  it('已加密的 apiKey 不回显密文，留空并显示「已加密」徽章', async () => {
    const { configAPI } = await import('../services/config.js')
    const encConfig = {
      ...mockConfig,
      providers: [
        { name: 'Enc', protocol: 'openai', apiKey: 'enc:898L9mF6CILM', baseURL: 'https://a/v1' },
      ],
    }
    ;(configAPI.get as Mock).mockResolvedValue(encConfig)

    renderSettings()
    await waitFor(() => expect(screen.getAllByTestId('provider-row')).toHaveLength(1))

    const apiKeyInput = screen.getByTestId('provider-apikey') as HTMLInputElement
    expect(apiKeyInput.value).toBe('')
    expect(apiKeyInput.placeholder).toContain('已加密')
    expect(screen.getByTestId('provider-apikey-saved').textContent).toContain('已加密')
    // 密文不得出现在 DOM 中
    expect(document.body.textContent ?? '').not.toContain('enc:898L9mF6CILM')
  })

  it('重新输入 apiKey 后保存提交明文（可被服务端加密）', async () => {
    const { configAPI } = await import('../services/config.js')
    const encConfig = {
      ...mockConfig,
      providers: [
        { name: 'Enc', protocol: 'openai', apiKey: 'enc:898L9mF6CILM', baseURL: 'https://a/v1' },
      ],
    }
    ;(configAPI.get as Mock).mockResolvedValue(encConfig)
    ;(configAPI.update as Mock).mockResolvedValue(encConfig)

    renderSettings()
    await waitFor(() => expect(screen.getAllByTestId('provider-row')).toHaveLength(1))

    const apiKeyInput = screen.getByTestId('provider-apikey') as HTMLInputElement
    fireEvent.change(apiKeyInput, { target: { value: 'sk-new-plaintext' } })
    expect(apiKeyInput.value).toBe('sk-new-plaintext')

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      providers: { apiKey: string }[]
    }
    expect(args.providers[0]?.apiKey).toBe('sk-new-plaintext')
  })

  // 回归：保存后应有成功反馈，并清空草稿（按钮禁用）。
  it('保存成功后显示「已保存」反馈并清空草稿', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('provider-add'))
    fireEvent.change(screen.getAllByPlaceholderText('名称').at(-1) as HTMLElement, {
      target: { value: 'P' },
    })
    fireEvent.click(screen.getByTestId('settings-save'))

    await waitFor(() => {
      expect(screen.getByTestId('settings-save-status').textContent).toContain('已保存')
    })
  })
})

describe('Settings — 默认 Provider/Model 下拉选择', () => {
  // 来源：默认 Provider/Model 改为从已配置 provider 派生的 select（取代手动输入）
  const configWithModels = {
    ...mockConfig,
    providers: [
      {
        name: 'Alpha',
        protocol: 'openai',
        apiKey: 'k1',
        baseURL: 'https://a',
        models: { 'a-1': {}, 'a-disabled': { enabled: false } },
      },
      {
        name: 'Beta',
        protocol: 'anthropic',
        apiKey: 'k2',
        baseURL: 'https://b',
        models: { 'b-1': {}, 'b-2': {} },
      },
    ],
    defaultProvider: 'Alpha',
    defaultModel: 'a-1',
  }

  it('默认 Provider select 选项来自已配置 provider', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(configWithModels)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('default-provider-select')).toBeTruthy())

    const sel = screen.getByTestId('default-provider-select') as HTMLSelectElement
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['Alpha', 'Beta'])
    expect(sel.value).toBe('Alpha')
  })

  it('默认 Model select 仅列出当前 provider 启用的模型', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(configWithModels)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('default-model-select')).toBeTruthy())

    const sel = screen.getByTestId('default-model-select') as HTMLSelectElement
    // a-disabled 被过滤；当前值 a-1 命中候选，无兜底 option
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['a-1'])
    expect(sel.value).toBe('a-1')
  })

  it('切换默认 provider 时 model 自动校正为该 provider 首个启用模型', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(configWithModels)
    ;(configAPI.update as Mock).mockResolvedValue(configWithModels)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('default-provider-select')).toBeTruthy())

    fireEvent.change(screen.getByTestId('default-provider-select'), {
      target: { value: 'Beta' },
    })

    const modelSel = screen.getByTestId('default-model-select') as HTMLSelectElement
    await waitFor(() => expect(modelSel.value).toBe('b-1'))

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      defaultProvider: string
      defaultModel: string
    }
    expect(args.defaultProvider).toBe('Beta')
    expect(args.defaultModel).toBe('b-1')
  })
})

describe('Settings — JSON 模式与导入导出', () => {
  it('点击 JSON 切换显示编辑器，内容为当前配置序列化', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('settings-mode-json'))

    const editor = screen.getByTestId('settings-json-editor') as HTMLTextAreaElement
    expect(editor).toBeTruthy()
    expect(editor.value).toContain('"defaultModel": "gpt-4"')
    expect(editor.value).toContain('ProviderA')
  })

  it('JSON 编辑合法时同步到 draft，保存提交新值', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('settings-mode-json'))
    const editor = screen.getByTestId('settings-json-editor') as HTMLTextAreaElement
    const updated = { ...mockConfig, defaultModel: 'claude-3' }
    fireEvent.change(editor, { target: { value: JSON.stringify(updated, null, 2) } })

    expect(screen.queryByTestId('settings-json-error')).toBeNull()

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as { defaultModel: string }
    expect(args.defaultModel).toBe('claude-3')
  })

  it('JSON 语法错误时显示错误条', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('settings-mode-json'))
    const editor = screen.getByTestId('settings-json-editor') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '{ invalid json' } })

    expect(screen.getByTestId('settings-json-error')).toBeTruthy()
  })

  it('JSON 错误时切回表单被阻止（停留在 JSON）', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('settings-mode-json'))
    const editor = screen.getByTestId('settings-json-editor') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '{ invalid' } })

    fireEvent.click(screen.getByTestId('settings-mode-gui'))
    // 仍停留在 JSON 模式
    expect(screen.getByTestId('settings-json-editor')).toBeTruthy()
    expect(screen.queryByTestId('provider-add')).toBeNull()
  })

  it('导出触发 Blob 下载（createObjectURL/revokeObjectURL 各一次）', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)
    const createURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock')
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    // 阻止 anchor.click 真正导航
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('settings-export'))

    expect(createURLSpy).toHaveBeenCalledTimes(1)
    expect(revokeSpy).toHaveBeenCalledTimes(1)

    createURLSpy.mockRestore()
    revokeSpy.mockRestore()
    clickSpy.mockRestore()
  })

  it('导入合法 JSON 文件后应用配置并切回表单，保存提交导入值', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    const imported = { ...mockConfig, defaultModel: 'imported-model' }
    const mockFile = {
      text: () => Promise.resolve(JSON.stringify(imported)),
    } as unknown as File
    const input = screen.getByTestId('settings-import-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [mockFile] } })

    // 切回 GUI 模式，defaultModel select 反映导入值（受控 select 用 value 断言）
    await waitFor(() => {
      const sel = screen.getByTestId('default-model-select') as HTMLSelectElement
      expect(sel.value).toBe('imported-model')
    })

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as { defaultModel: string }
    expect(args.defaultModel).toBe('imported-model')
  })

  it('导入非法 JSON 文件时显示错误并切到 JSON 模式', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    const mockFile = { text: () => Promise.resolve('{ not valid') } as unknown as File
    const input = screen.getByTestId('settings-import-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [mockFile] } })

    await waitFor(() => expect(screen.getByTestId('settings-json-error')).toBeTruthy())
    expect(screen.getByTestId('settings-json-editor')).toBeTruthy()
  })
})

describe('Settings — 完整配置表单覆盖', () => {
  it('所有配置分区均渲染', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    for (const title of [
      '外观',
      '默认 Provider / Model',
      'LLM Provider',
      '角色路由',
      '故障回退',
      '上下文压缩',
      '工具配置',
      '工具指标',
      '插件',
      '斜杠命令',
      'MCP 服务器',
      'Web 搜索',
      '多 Agent',
      '安全',
      '自动授权',
    ]) {
      expect(headings).toContain(title)
    }
  })

  it('自动授权段落 select 切换并保存', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // 定位「自动授权」段落并取其内 select
    const permHeading = screen
      .getAllByRole('heading', { level: 3 })
      .find((h) => h.textContent === '自动授权')
    expect(permHeading).toBeTruthy()
    const section = permHeading?.closest('div')
    const select = within(section as HTMLElement).getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('default')

    fireEvent.change(select, { target: { value: 'auto' } })

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      permission: { defaultMode: string }
    }
    expect(args.permission.defaultMode).toBe('auto')
  })

  it('编辑故障回退字段后保存提交正确值', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // 勾选启用回退 checkbox
    const fallbackCheck = screen
      .getAllByRole('checkbox')
      .find((cb) => cb.closest('label')?.textContent?.includes('启用自动重试与回退'))
    expect(fallbackCheck).toBeTruthy()
    fireEvent.click(fallbackCheck as HTMLElement)

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      fallback: { enabled: boolean }
    }
    expect(args.fallback.enabled).toBe(true)
  })

  it('编辑上下文压缩全部字段后保存提交完整对象', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // 修改保留 Token 数值（用 label 文本精确定位，避免与同值输入框混淆）
    const reserveLabel = screen.getByText('保留 Token：').closest('label')
    const reserveInput = reserveLabel?.querySelector('input') as HTMLInputElement
    expect(reserveInput).toBeTruthy()
    fireEvent.change(reserveInput, { target: { value: '9999' } })

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      compaction: { reserveTokens: number; threshold: number }
    }
    expect(args.compaction.reserveTokens).toBe(9999)
    // 其他字段被保留（浅合并不丢失）
    expect(args.compaction.threshold).toBe(mockConfig.compaction.threshold)
  })

  it('勾选压缩独立模型后显示 provider/model 下拉并保存', async () => {
    const { configAPI } = await import('../services/config.js')
    const cfg = {
      ...mockConfig,
      providers: [
        {
          name: 'Alpha',
          protocol: 'openai',
          apiKey: 'k1',
          baseURL: 'https://a',
          models: { 'a-1': {}, 'a-2': {} },
        },
        {
          name: 'Beta',
          protocol: 'anthropic',
          apiKey: 'k2',
          baseURL: 'https://b',
          models: { 'b-1': {} },
        },
      ],
      defaultProvider: 'Alpha',
      defaultModel: 'a-1',
    }
    ;(configAPI.get as Mock).mockResolvedValue(cfg)
    ;(configAPI.update as Mock).mockResolvedValue(cfg)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // 勾选「压缩使用独立模型」复选框
    const cmCheckbox = screen
      .getByText('压缩使用独立模型（摘要任务对推理要求低，可指定便宜模型）')
      .closest('label')
      ?.querySelector('input') as HTMLInputElement
    expect(cmCheckbox).toBeTruthy()
    fireEvent.click(cmCheckbox)

    // 下拉出现，默认值为当前 defaultProvider/defaultModel
    const providerSel = await waitFor(
      () => screen.getByTestId('compaction-provider-select') as HTMLSelectElement,
    )
    const modelSel = screen.getByTestId('compaction-model-select') as HTMLSelectElement
    expect(providerSel.value).toBe('Alpha')
    expect(modelSel.value).toBe('a-1')

    // 切换到 Beta → model 自动校正为 b-1
    fireEvent.change(providerSel, { target: { value: 'Beta' } })
    await waitFor(() => expect(modelSel.value).toBe('b-1'))

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      compaction: { compactionModel: { provider: string; model: string } }
    }
    expect(args.compaction.compactionModel).toEqual({ provider: 'Beta', model: 'b-1' })
  })

  it('取消勾选压缩独立模型后 compactionModel 被清除', async () => {
    const { configAPI } = await import('../services/config.js')
    const cfg = {
      ...mockConfig,
      compaction: {
        ...mockConfig.compaction,
        compactionModel: { provider: 'Alpha', model: 'a-1' },
      },
      providers: [
        {
          name: 'Alpha',
          protocol: 'openai',
          apiKey: 'k1',
          baseURL: 'https://a',
          models: { 'a-1': {} },
        },
      ],
      defaultProvider: 'Alpha',
      defaultModel: 'a-1',
    }
    ;(configAPI.get as Mock).mockResolvedValue(cfg)
    ;(configAPI.update as Mock).mockResolvedValue(cfg)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // 初始已勾选 → 下拉可见
    expect(screen.getByTestId('compaction-provider-select')).toBeTruthy()

    // 取消勾选
    const cmCheckbox = screen
      .getByText('压缩使用独立模型（摘要任务对推理要求低，可指定便宜模型）')
      .closest('label')
      ?.querySelector('input') as HTMLInputElement
    fireEvent.click(cmCheckbox)

    // 下拉消失
    expect(screen.queryByTestId('compaction-provider-select')).toBeNull()

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      compaction: { compactionModel?: { provider: string; model: string } }
    }
    expect(args.compaction.compactionModel).toBeUndefined()
  })

  it('添加并删除 MCP 服务器', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('mcp-add'))
    expect(screen.getAllByTestId('mcp-row')).toHaveLength(1)

    fireEvent.click(screen.getByTestId('mcp-remove'))
    expect(screen.queryByTestId('mcp-row')).toBeNull()
  })

  it('启用安全认证后显示 Token 输入框', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // 初始 authEnabled=false，Token 输入框不显示
    expect(screen.queryByPlaceholderText('Bearer Token')).toBeNull()

    // 勾选启用认证
    const authCheck = screen
      .getAllByRole('checkbox')
      .find((cb) => cb.closest('label')?.textContent?.includes('Bearer Token 认证'))
    expect(authCheck).toBeTruthy()
    fireEvent.click(authCheck as HTMLElement)

    // Token 输入框出现
    expect(screen.getByPlaceholderText('Bearer Token')).toBeTruthy()
  })

  it('切换 Web 搜索后端并保存', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // 找到 Web 搜索区的 select（在包含 "后端" 的 label 内）
    const allSelects = screen.getAllByRole('combobox')
    const websearchSelect = allSelects.find(
      (s) =>
        s.closest('label')?.textContent?.includes('后端') &&
        (s as HTMLSelectElement).value === 'auto',
    ) as HTMLSelectElement
    expect(websearchSelect).toBeTruthy()
    fireEvent.change(websearchSelect, { target: { value: 'tavily' } })

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      websearch: { provider: string }
    }
    expect(args.websearch.provider).toBe('tavily')
  })

  it('编辑多 Agent 并发数并保存', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    const concurrencyLabel = screen.getByText('子 Agent 并发数：').closest('label')
    const concurrencyInput = concurrencyLabel?.querySelector('input') as HTMLInputElement
    fireEvent.change(concurrencyInput, { target: { value: '7' } })

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      agents: { subagentConcurrency: number }
    }
    expect(args.agents.subagentConcurrency).toBe(7)
  })

  // 回归：逗号分隔列表输入（tools.enabled 等）此前用 value={array.join(', ')} +
  // onChange=parseList，每次按键 parse→join 会抹掉刚输入的逗号，导致无法输入分隔符、
  // 最终保存空数组（“保存无效、刷新后恢复原值”的根因）。CommaListInput 用内部文本缓冲修复。
  it('逗号分隔列表输入可输入逗号并随保存提交（tools.enabled）', async () => {
    const { configAPI } = await import('../services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(mockConfig)
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    const enabledLabel = screen.getByText('已启用：').closest('label')
    const enabledInput = enabledLabel?.querySelector('input') as HTMLInputElement
    // 模拟逐字符输入：旧实现会把逗号抹掉得到 'readwriteedit'，修复后应保留分隔符
    fireEvent.change(enabledInput, { target: { value: 'read, write, edit' } })
    expect(enabledInput.value).toBe('read, write, edit')

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      tools: { enabled: string[] }
    }
    expect(args.tools.enabled).toEqual(['read', 'write', 'edit'])
  })
})
