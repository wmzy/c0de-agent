/**
 * Settings 视图测试，对应 src/web/views/Settings.tsx。
 */

import { createRoutes, MemoryRouter, TypedLink, View } from '@native-router/react'
import type { Config } from '@shared/types/config.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Mock } from 'vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { horizontalWheelTarget } from '@/components/settings/sectionScroll.js'
import { useCommands } from '@/hooks/useCommands.js'
import type { AppPaths } from '@/routes.js'
import { Settings } from '@/views/Settings.js'

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
  toolMetrics: { enabled: true, threshold: 0.8, minSamples: 5 },
  security: { authEnabled: false, allowedOrigins: [] },
  websearch: { provider: 'auto' },
  agents: { subagentConcurrency: 3 },
  permission: { defaultMode: 'default' },
  usage: { monthlyBudgetUsd: 0 },
}

vi.mock('@/services/config.js', () => ({
  configAPI: {
    get: vi.fn(),
    update: vi.fn(),
  },
}))

/** 把裸 Config（测试夹具的松散字面量）包装成 GET/PATCH /api/config 的响应结构。 */
function wrapConfig(config: unknown): { config: Partial<Config> } {
  return { config: config as Partial<Config> }
}

vi.mock('@/services/provider.js', () => ({
  providerAPI: {
    test: vi.fn(),
  },
}))

// ProviderCatalogDialog 依赖 catalog service，mock 掉避免测试中发起网络请求
vi.mock('@/services/catalog.js', () => ({
  catalogAPI: {
    listProviders: vi.fn(),
    getProviderModels: vi.fn(),
    search: vi.fn(),
    refresh: vi.fn(),
  },
}))

// 设备管理面板依赖 auth service，mock 掉避免测试中发起网络请求
vi.mock('../services/auth.js', () => ({
  authAPI: {
    listDevices: vi.fn().mockResolvedValue({ devices: [] }),
    revokeDevice: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

vi.mock('../contexts/ThemeContext.js', () => ({
  useTheme: () => ({ mode: 'light', setMode: vi.fn() }),
}))

// 工作流管理面板依赖 workflows service，mock 掉避免测试中发起网络请求
vi.mock('@/services/workflows.js', () => ({
  workflowsAPI: {
    list: vi.fn().mockResolvedValue({ workflows: [] }),
    get: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
  },
}))

vi.mock('@/services/commands.js', () => ({
  commandsAPI: {
    list: vi.fn(),
  },
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
    <MemoryRouter routes={settingsTestRoutes} initialEntries={['/settings']}>
      <QueryClientProvider client={qc}>
        <View />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

// Settings 经 useMatched 读路由 params（/projects/:projectId/settings 提供 projectId），
// useBlocker 需 Router 上下文——测试路由表覆盖两种设置页形态。
const settingsTestRoutes = createRoutes({
  children: [
    { path: '/settings', component: () => Settings },
    { path: '/projects/:projectId/settings', component: () => Settings },
  ],
})

// 未保存防护集成测试：真实 in-app 导航（TypedLink → navigate）触发 useBlocker veto。
// 目标路由渲染 ProjectProbe 作为「导航已提交」的可观察标记。
const guardTestRoutes = createRoutes({
  children: [
    { path: '/settings', component: () => Settings },
    { path: '/projects/:projectId', component: () => ProjectProbe },
  ],
})

function ProjectProbe() {
  return <div data-testid="project-view" />
}

function NavigateProbe() {
  return (
    <TypedLink<AppPaths>
      to="/projects/:projectId"
      params={{ projectId: 'p1' }}
      data-testid="leave-link"
    >
      会话
    </TypedLink>
  )
}

function renderSettingsGuarded() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  return render(
    <MemoryRouter routes={guardTestRoutes} initialEntries={['/settings']}>
      <QueryClientProvider client={qc}>
        <View />
        <NavigateProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('Settings — 读失败态', () => {
  /**
   * 回归：此前 `if (isLoading || !config) return <div>加载中…</div>`。
   * 请求 500 时 isLoading 已转 false 而 config 恒为 null（resp 为 undefined），
   * 两者并成一条 → 设置页永久停在「加载中…」，无错误、无重试。
   * 实测注入 /api/config 500、retry:2 耗尽后 40s+ 仍是「加载中…」。
   * 设置页是配 provider/token/权限的唯一入口，落到永远加载 = 整个应用不可配置。
   */
  it('配置读取失败时展示原因，而不是永远「加载中…」', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockRejectedValue({
      status: 500,
      message: '配置文件读取失败',
    })
    renderSettings()

    const box = await screen.findByTestId('settings-load-error')
    expect(box.textContent).toContain('设置加载失败')
    expect(box.textContent).toContain('配置文件读取失败')
    // 关键：失败后不得继续显示「加载中…」
    expect(screen.queryByText('加载中…')).toBeNull()
    expect(screen.getByTestId('settings-retry')).toBeInTheDocument()
  })

  it('APIError 走结构化 message 而非 [object Object]', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockRejectedValue({
      status: 500,
      code: 'DB_LOCKED',
      message: '配置数据库被占用',
    })
    renderSettings()

    const box = await screen.findByTestId('settings-load-error')
    expect(box.textContent).toContain('配置数据库被占用')
    expect(box.textContent).not.toContain('[object Object]')
  })

  it('网络异常（真正的 Error）也展示其 message', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockRejectedValue(new TypeError('Failed to fetch'))
    renderSettings()

    const box = await screen.findByTestId('settings-load-error')
    expect(box.textContent).toContain('Failed to fetch')
    expect(box.textContent).not.toContain('[object Object]')
  })

  it('请求成功但响应无 config 体时也不得停在「加载中…」', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue({})
    renderSettings()

    await screen.findByTestId('settings-load-error')
    expect(screen.queryByText('加载中…')).toBeNull()
    expect(screen.getByTestId('settings-retry')).toBeInTheDocument()
  })

  /**
   * 「失败」≠「没有数据」。
   *
   * 缺陷：分支只看 isError。react-query 在**后台重取**失败时会把 status 打成 error
   * 但保留上一次成功的数据，于是保存成功 → ✓ 已保存 → 紧接着那次
   * invalidateQueries 重取失败，整张表单被替换成「设置加载失败」：界面自相矛盾
   * （刚说保存成功，又说来不了），用户以为自己的改动没了（其实草稿完好，只是被
   * 藏到错误屏后面）。真实浏览器实测：拦截保存后的 GET /api/config 返回 500 后，
   * [data-testid="settings-form"] 消失、settings-load-error 出现。
   *
   * 修法：只有**从没拿到过数据**时才整页报错（isError && !resp），拿到过就把重取
   * 失败降级成表单上方的横幅。
   */
  it('保存后的后台重取失败时保留表单（不整页报错）并给出横幅', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValueOnce(wrapConfig(mockConfig))
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // 让 draft 变脏（保存成功后 invalidateQueries 会触发重取）
    fireEvent.click(screen.getByTestId('provider-add'))
    const nameInputs = screen.getAllByPlaceholderText('名称')
    fireEvent.change(nameInputs[nameInputs.length - 1] as HTMLElement, {
      target: { value: 'MyProvider' },
    })

    // 保存后的那次重取失败
    ;(configAPI.get as Mock).mockRejectedValue({ status: 500, message: '配置服务暂时不可用' })
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())

    const banner = await screen.findByTestId('config-refetch-error')
    expect(banner.textContent).toContain('配置服务暂时不可用')
    // 关键：表单与草稿都还在，没有退化成整页错误屏
    expect(screen.getByTestId('settings-form')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-load-error')).toBeNull()
  })

  it('点击重试重新拉取配置', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockRejectedValue({ status: 500, message: 'boom' })
    renderSettings()

    await screen.findByTestId('settings-load-error')
    ;(configAPI.get as Mock).mockClear()
    fireEvent.click(screen.getByTestId('settings-retry'))
    expect(configAPI.get).toHaveBeenCalled()
  })

  it('重试成功后从失败态恢复到设置表单', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockRejectedValueOnce({ status: 500, message: 'boom' })
    renderSettings()
    await screen.findByTestId('settings-load-error')

    ;(configAPI.get as Mock).mockResolvedValueOnce(wrapConfig(mockConfig))
    fireEvent.click(screen.getByTestId('settings-retry'))

    await waitFor(() => {
      expect(screen.queryByTestId('settings-load-error')).toBeNull()
    })
    expect(await screen.findByText('ProviderA')).toBeInTheDocument()
  })
})

describe('Settings — Provider 管理', () => {
  it('渲染时显示已加载 config 的 providers', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

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
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()

    await waitFor(() => {
      expect(screen.getByTestId('provider-add')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('provider-add'))

    const rows = screen.getAllByTestId('provider-row')
    expect(rows).toHaveLength(3)
  })

  it('点击「测试」调用 providerAPI.test 并显示成功结果', async () => {
    const { configAPI } = await import('@/services/config.js')
    const { providerAPI } = await import('@/services/provider.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
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

  // 删除 provider 要先过确认框（行里是手打的 baseURL + API Key，删掉无处取回），
  // 与同页 MCP 服务器删除同一口径——此前这里单击即删，保存条随即点亮。
  it('点击「删除」经确认后才移除一行', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()

    await waitFor(() => {
      expect(screen.getAllByTestId('provider-row')).toHaveLength(2)
    })

    // 删除第一行
    fireEvent.click(screen.getAllByTestId('provider-remove')[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('ProviderA')
    // 确认前两行都还在
    expect(screen.getAllByTestId('provider-row')).toHaveLength(2)

    fireEvent.click(within(dialog).getByText('删除'))

    await waitFor(() => {
      expect(screen.getAllByTestId('provider-row')).toHaveLength(1)
    })
    const rows = screen.getAllByTestId('provider-row')
    // 仅在剩余 provider-row 内检查 ProviderA 已被删除
    const remaining = within(rows[0] as HTMLElement)
    expect(remaining.queryByDisplayValue('ProviderA')).toBeNull()
    expect(remaining.getByDisplayValue('ProviderB')).toBeTruthy()
  })

  it('点击「从 models.dev 选择」打开 catalog 弹窗', async () => {
    const { configAPI } = await import('@/services/config.js')
    const { catalogAPI } = await import('@/services/catalog.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
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
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
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

  // P1-1：首跑作用域引导——全局与当前项目都还没有 provider、且本次保存引入了
  // provider 时，弹一次「全局 or 项目」确认；确认后写入全局作用域（所有项目与
  // CLI 可见），作用域选择器同步。
  it('首跑保存 provider：确认 → 写入全局作用域', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue({
      config: { ...mockConfig, providers: [] },
      scopes: { global: {}, project: {} },
      warnings: [],
    })
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('provider-add'))
    const nameInputs = screen.getAllByPlaceholderText('名称')
    fireEvent.change(nameInputs[nameInputs.length - 1] as HTMLElement, {
      target: { value: 'MyProvider' },
    })
    fireEvent.click(screen.getByTestId('settings-save'))

    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const [, scopeArg] = (configAPI.update as Mock).mock.calls[0] ?? []
    expect(scopeArg).toBe('global')
    expect(screen.getByTestId('scope-select')).toHaveProperty('value', 'global')
    vi.unstubAllGlobals()
  })

  it('首跑保存 provider：取消 → 保持项目作用域', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue({
      config: { ...mockConfig, providers: [] },
      scopes: { global: {}, project: {} },
      warnings: [],
    })
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('provider-add'))
    const nameInputs = screen.getAllByPlaceholderText('名称')
    fireEvent.change(nameInputs[nameInputs.length - 1] as HTMLElement, {
      target: { value: 'MyProvider' },
    })
    fireEvent.click(screen.getByTestId('settings-save'))

    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const [, scopeArg] = (configAPI.update as Mock).mock.calls[0] ?? []
    expect(scopeArg).toBe('project')
    vi.unstubAllGlobals()
  })

  it('全局已有 provider 时不弹确认（用户已做出作用域选择）', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue({
      config: { ...mockConfig, providers: [] },
      scopes: { global: { providers: [mockConfig.providers[0]] }, project: {} },
      warnings: [],
    })
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)
    const confirmSpy = vi.fn().mockReturnValue(true)
    vi.stubGlobal('confirm', confirmSpy)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('provider-add'))
    const nameInputs = screen.getAllByPlaceholderText('名称')
    fireEvent.change(nameInputs[nameInputs.length - 1] as HTMLElement, {
      target: { value: 'MyProvider' },
    })
    fireEvent.click(screen.getByTestId('settings-save'))

    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    expect(confirmSpy).not.toHaveBeenCalled()
    const [, scopeArg] = (configAPI.update as Mock).mock.calls[0] ?? []
    expect(scopeArg).toBe('project')
    vi.unstubAllGlobals()
  })

  it('测试成功后将检测到的模型写入 provider.models，保存时一并提交', async () => {
    const { configAPI } = await import('@/services/config.js')
    const { providerAPI } = await import('@/services/provider.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
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
    const { configAPI } = await import('@/services/config.js')
    const { providerAPI } = await import('@/services/provider.js')
    // ProviderA 已预设一个带 override 的模型
    ;(configAPI.get as Mock).mockResolvedValue(
      wrapConfig({
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
      }),
    )
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
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(configWithModels))

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
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(configWithModels))

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
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(configWithModels))

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
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(configWithModels))
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
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(configWithModels))

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

  it('过滤生效时批量启禁只作用于筛选出的模型，其余保持原状', async () => {
    // 回归：两个批量键紧挨过滤框，却一直遍历整张表——筛出 2 个模型点「禁用所有」，
    // 整 provider 一起被禁用，屏幕上唯一证据是计数器跳成 0 / 3。
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(configWithModels))

    renderSettings()
    await waitFor(() => expect(screen.getAllByTestId('provider-row')).toHaveLength(2))

    const panel = within(screen.getAllByTestId('provider-row')[0] as HTMLElement).getByTestId(
      'provider-models',
    ) as HTMLElement

    fireEvent.change(within(panel).getByTestId('provider-model-filter'), {
      target: { value: '4o' },
    })

    // 作用域写进可见文本，不只躺在 title 里
    expect(within(panel).getByTestId('provider-models-scope-hint').textContent).toContain(
      '筛选出的 2 个模型',
    )

    fireEvent.click(within(panel).getByTestId('provider-models-disable-all'))
    expect(within(panel).getByText('1 / 3 已启用')).toBeTruthy()

    // 清掉过滤后看全量：gpt-4 不在筛选结果里，必须保持启用
    fireEvent.change(within(panel).getByTestId('provider-model-filter'), {
      target: { value: '' },
    })
    expect(
      within(panel).getByTestId('provider-model-toggle-gpt-4') as HTMLInputElement,
    ).toBeChecked()
    expect(
      within(panel).getByTestId('provider-model-toggle-gpt-4o') as HTMLInputElement,
    ).not.toBeChecked()
  })

  it('过滤到无匹配时批量键禁用，不会把整 provider 一次性改掉', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(configWithModels))

    renderSettings()
    await waitFor(() => expect(screen.getAllByTestId('provider-row')).toHaveLength(2))

    const panel = within(screen.getAllByTestId('provider-row')[0] as HTMLElement).getByTestId(
      'provider-models',
    ) as HTMLElement

    fireEvent.change(within(panel).getByTestId('provider-model-filter'), {
      target: { value: '不存在的模型' },
    })

    expect(within(panel).getByTestId('provider-models-enable-all')).toBeDisabled()
    expect(within(panel).getByTestId('provider-models-disable-all')).toBeDisabled()
    expect(within(panel).getByText('2 / 3 已启用')).toBeTruthy()
  })

  it('编辑模型的上下文窗口/最大输出后随保存提交', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(configWithModels))
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
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

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
    const { configAPI } = await import('@/services/config.js')
    const encConfig = {
      ...mockConfig,
      providers: [
        { name: 'Enc', protocol: 'openai', apiKey: 'enc:898L9mF6CILM', baseURL: 'https://a/v1' },
      ],
    }
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(encConfig))

    renderSettings()
    await waitFor(() => expect(screen.getAllByTestId('provider-row')).toHaveLength(1))

    const apiKeyInput = screen.getByTestId('provider-apikey') as HTMLInputElement
    expect(apiKeyInput.value).toBe('')
    expect(apiKeyInput.placeholder).toContain('已加密')
    expect(screen.getByTestId('provider-apikey-saved').textContent).toContain('已加密')
    // 密文不得出现在 DOM 中
    expect(document.body.textContent ?? '').not.toContain('enc:898L9mF6CILM')
  })

  // 回归：已加密时把输入框清空不是「清空密钥」。密钥框是密码框且不回显密文，用户
  // 看不到「有内容」可删；逐字符提交的草稿会把 '' 交给保存，保存后 enc: 密文被
  // 覆盖、密钥永久丢失（无确认、无撤销，只剩徽章消失这一条线索）。留空 = 不修改，
  // 且必须当场说明。
  it('已加密时把输入框清空：保存不产生任何改动，并说明密钥保留', async () => {
    const { configAPI } = await import('@/services/config.js')
    const encConfig = {
      ...mockConfig,
      providers: [
        { name: 'Enc', protocol: 'openai', apiKey: 'enc:898L9mF6CILM', baseURL: 'https://a/v1' },
      ],
    }
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(encConfig))
    ;(configAPI.update as Mock).mockResolvedValue(encConfig)

    renderSettings()
    await waitFor(() => expect(screen.getAllByTestId('provider-row')).toHaveLength(1))

    const apiKeyInput = screen.getByTestId('provider-apikey') as HTMLInputElement
    fireEvent.change(apiKeyInput, { target: { value: 'sk-temporary' } })
    fireEvent.change(apiKeyInput, { target: { value: '' } })

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() =>
      expect(screen.getByTestId('settings-save-status')).toHaveTextContent('未改动'),
    )
    expect(screen.getByTestId('settings-save-status')).toHaveTextContent('原有密钥保留')
    // 草稿退回原密文 → diff 为空 → 不发 PATCH（更不会把 apiKey 写成空串）
    expect(configAPI.update).not.toHaveBeenCalled()
  })

  it('重新输入 apiKey 后保存提交明文（可被服务端加密）', async () => {
    const { configAPI } = await import('@/services/config.js')
    const encConfig = {
      ...mockConfig,
      providers: [
        { name: 'Enc', protocol: 'openai', apiKey: 'enc:898L9mF6CILM', baseURL: 'https://a/v1' },
      ],
    }
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(encConfig))
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
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
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

  // 回归：保存请求在飞期间（磁盘慢/配置大时可达数秒，表单此时没有在途禁写）
  // 用户继续编辑，onSuccess 无条件 setDraft(null) 会把这批新编辑整块抹掉——
  // 保存条回显「✓ 已保存」、脏标记消失，屏幕上刚打的字无声不见。
  it('保存请求在飞期间的新编辑不会被成功回调清掉', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    let resolveUpdate: (value: unknown) => void = () => {}
    ;(configAPI.update as Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve
        }),
    )

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('provider-add'))
    fireEvent.change(screen.getAllByPlaceholderText('名称').at(-1) as HTMLElement, {
      target: { value: 'P' },
    })
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())

    // 请求仍在飞：用户接着把这一行改成 Q
    fireEvent.change(screen.getAllByPlaceholderText('名称').at(-1) as HTMLElement, {
      target: { value: 'Q' },
    })

    await act(async () => {
      resolveUpdate(mockConfig)
    })

    // 修复前：草稿被清空 → 该行整个消失（Q 无处可寻），脏标记也没了
    const names = screen.getAllByPlaceholderText('名称') as HTMLInputElement[]
    expect(names.at(-1)?.value).toBe('Q')
    expect(screen.getByTestId('settings-dirty-hint')).toBeTruthy()
  })

  // 可访问性：每个 Provider 表单控件须有显式关联的 label（label[for] ↔ control#id）
  it('Provider 表单控件均有显式关联的 label（名称/协议/URL/API Key）', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getAllByTestId('provider-row')).toHaveLength(2))

    const rows = screen.getAllByTestId('provider-row')
    // 名称/协议/URL 是直接控件；APIKey 在 ApiKeyInput 内（data-testid=provider-apikey）
    const controls = rows.flatMap((row) => {
      const r = within(row as HTMLElement)
      return [
        r.getByLabelText('名称') as HTMLElement,
        r.getByLabelText('协议') as HTMLElement,
        r.getByLabelText('URL') as HTMLElement,
        r.getByTestId('provider-apikey') as HTMLElement,
      ]
    })
    expect(controls).toHaveLength(8)

    for (const control of controls) {
      const id = control.getAttribute('id')
      expect(id, '控件须有 id 供 label[for] 关联').toBeTruthy()
      const label = document.querySelector(`label[for="${id}"]`)
      expect(label, `控件 #${id} 须有关联 label[for]`).toBeTruthy()
      // label 文本非空（非空串标签）
      expect((label as HTMLElement).textContent?.trim().length ?? 0).toBeGreaterThan(0)
    }
  })

  // 可访问性：设置页标题为页面唯一 h1；Provider/区块标题为 h2
  it('页面标题「⚙ 设置」为唯一 h1，区块标题为 h2', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
    expect(h1s[0]?.textContent).toBe('⚙ 设置')

    const h2Texts = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(h2Texts).toContain('LLM Provider')
    expect(h2Texts).not.toContain('外观 ') // 无重复/空白污染
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
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(configWithModels))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('default-provider-select')).toBeTruthy())

    const sel = screen.getByTestId('default-provider-select') as HTMLSelectElement
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['Alpha', 'Beta'])
    expect(sel.value).toBe('Alpha')
  })

  it('默认 Model select 仅列出当前 provider 启用的模型', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(configWithModels))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('default-model-select')).toBeTruthy())

    const sel = screen.getByTestId('default-model-select') as HTMLSelectElement
    // a-disabled 被过滤；当前值 a-1 命中候选，无兜底 option
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['a-1'])
    expect(sel.value).toBe('a-1')
  })

  it('切换默认 provider 时 model 自动校正为该 provider 首个启用模型', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(configWithModels))
    ;(configAPI.update as Mock).mockResolvedValue(configWithModels)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('default-provider-select')).toBeTruthy())

    fireEvent.change(screen.getByTestId('default-provider-select'), {
      target: { value: 'Beta' },
    })

    // model 下拉随 defaultModel 变化 key 重挂载，等待期间重新查询元素
    await waitFor(() => {
      const sel = screen.getByTestId('default-model-select') as HTMLSelectElement
      expect(sel.value).toBe('b-1')
    })

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
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('settings-mode-json'))

    const editor = screen.getByTestId('settings-json-editor') as HTMLTextAreaElement
    expect(editor).toBeTruthy()
    expect(editor.value).toContain('"defaultModel": "gpt-4"')
    expect(editor.value).toContain('ProviderA')
  })

  // 「留空 = 不修改」只属于表单：JSON 视图里 `"apiKey": ""` 是用户亲手写下的明确
  // 值，必须照原样提交（否则 JSON 视图里清空密钥会变成静默不生效）。
  it('JSON 视图把 apiKey 写成空串照常提交（表单的留空约定不越过 JSON 编辑）', async () => {
    const { configAPI } = await import('@/services/config.js')
    const encConfig = {
      ...mockConfig,
      providers: [
        { name: 'Enc', protocol: 'openai', apiKey: 'enc:898L9mF6CILM', baseURL: 'https://a/v1' },
      ],
    }
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(encConfig))
    ;(configAPI.update as Mock).mockResolvedValue(encConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('settings-mode-json'))
    const editor = screen.getByTestId('settings-json-editor') as HTMLTextAreaElement
    const updated = {
      ...encConfig,
      providers: [{ ...encConfig.providers[0], apiKey: '' }],
    }
    fireEvent.change(editor, { target: { value: JSON.stringify(updated, null, 2) } })
    expect(screen.queryByTestId('settings-json-error')).toBeNull()

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      providers: { apiKey: string }[]
    }
    expect(args.providers[0]?.apiKey).toBe('')
  })

  it('JSON 编辑合法时同步到 draft，保存提交新值', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
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

  // 回归：JSON 视图语法错误时 draft 仍停在「最后一次合法解析」上，而保存条只看
  // isDirty（= draft !== null），与 jsonError 无关 —— 按钮照常可点，点下去落盘的是
  // 错误发生前的旧草稿，保存条却回显「✓ 已保存」。屏幕上的改动静默消失，
  // 刷新即丢，用户全程没有被告知「保存的不是你看到的内容」。
  it('JSON 语法错误时保存被拦下：不提交旧草稿，并明示修复语法错误后才能保存', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('settings-mode-json'))
    const editor = screen.getByTestId('settings-json-editor') as HTMLTextAreaElement

    // 先改一处合法值（draft 变脏、isDirty=true），再把文本改成非法 JSON
    fireEvent.change(editor, {
      target: { value: JSON.stringify({ ...mockConfig, defaultModel: 'claude-3' }, null, 2) },
    })
    fireEvent.change(editor, { target: { value: '{ invalid json' } })

    const save = screen.getByTestId('settings-save') as HTMLButtonElement
    expect(save.disabled).toBe(true)

    fireEvent.click(save)
    // 旧草稿不得落盘
    expect(configAPI.update).not.toHaveBeenCalled()
    // 且要能看出为什么按不动：保存条挂上原因，而不是只留 JSON 视图内那条错误条
    expect(screen.getByTestId('settings-save-blocked-hint').textContent).toContain('JSON')
  })

  it('JSON 语法错误时显示错误条', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('settings-mode-json'))
    const editor = screen.getByTestId('settings-json-editor') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '{ invalid json' } })

    expect(screen.getByTestId('settings-json-error')).toBeTruthy()
  })

  it('JSON 错误时切回表单被阻止（停留在 JSON）', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

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

  it('导出触发 Blob 下载，且剔除明文 security.token', async () => {
    const { configAPI } = await import('@/services/config.js')
    const withToken = {
      ...mockConfig,
      security: { authEnabled: true, token: 'secret-plain-token', allowedOrigins: [] },
    }
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(withToken))
    let exportedBlob: Blob | null = null
    const createURLSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      exportedBlob = blob as Blob
      return 'blob:mock'
    })
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    // 阻止 anchor.click 真正导航
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('settings-export'))

    expect(createURLSpy).toHaveBeenCalledTimes(1)
    expect(revokeSpy).toHaveBeenCalledTimes(1)
    // P3：明文 token 不出现在导出内容中
    expect(exportedBlob).not.toBeNull()
    const exportedText = await (exportedBlob ?? new Blob()).text()
    expect(exportedText).not.toContain('secret-plain-token')

    createURLSpy.mockRestore()
    revokeSpy.mockRestore()
    clickSpy.mockRestore()
  })

  it('导入合法 JSON 文件后应用配置并切回表单，保存提交导入值', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
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
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    const mockFile = { text: () => Promise.resolve('{ not valid') } as unknown as File
    const input = screen.getByTestId('settings-import-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [mockFile] } })

    await waitFor(() => expect(screen.getByTestId('settings-json-error')).toBeTruthy())
    expect(screen.getByTestId('settings-json-editor')).toBeTruthy()
  })

  /**
   * 回归：此前导入只做 JSON.parse 就把对象铺进表单（setDraft + 切 GUI）。
   * - 类别不符的配置（`{"plugins":{"enabled":"demo"}}`）让面板拿到错误类型的值；
   * - 缺字段的配置（`{"plugins":{}}`、`{"tools":{"disabled":["bash"]}}`）让
   *   merged.plugins.enabled 变成 undefined → CommaListInput 的 value.join 抛错。
   * 两条都会让整页被 ErrorBoundary 替换成「页面渲染出错」，未保存编辑丢失，
   * 用户也看不出是导入的文件有问题。
   */
  it('导入类别不符的配置：留在 JSON 视图给原因，不铺进表单导致整页崩溃', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    const mockFile = {
      text: () => Promise.resolve('{"plugins":{"enabled":"demo"}}'),
    } as unknown as File
    const input = screen.getByTestId('settings-import-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [mockFile] } })

    // 不切表单：留在 JSON 视图，且页面没有崩掉
    await waitFor(() =>
      expect(screen.getByTestId('settings-json-error').textContent).toContain('配置结构错误'),
    )
    expect(screen.getByTestId('settings-json-editor')).toBeTruthy()
    expect(screen.queryByTestId('provider-add')).toBeNull()
    const errorBar = screen.getByTestId('settings-json-error')
    expect(errorBar.textContent).toContain('plugins.enabled：应为数组，实际是字符串')
    // 「表单」按钮禁用并说明原因（此前是静默无反应）
    const guiBtn = screen.getByTestId('settings-mode-gui') as HTMLButtonElement
    expect(guiBtn.disabled).toBe(true)
    expect(guiBtn.title).toContain('plugins.enabled')
  })

  it('缺字段的配置导入后不再崩：缺失键按当前值补全，导入值生效', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // 旧实现下这份文件会让表单里 tools.enabled / plugins.enabled 变成
    // undefined → value.join 抛错 → 整页崩溃。
    const mockFile = {
      text: () => Promise.resolve('{"tools":{"disabled":["bash"]},"plugins":{}}'),
    } as unknown as File
    const input = screen.getByTestId('settings-import-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [mockFile] } })

    // 切回表单且不再崩溃：enabled 由当前配置补全，disabled 用导入值
    // （导入是异步的：以导入值出现为信号，不能等到「表单在不在」——表单本就在）
    await waitFor(() =>
      expect((screen.getByLabelText('已禁用') as HTMLInputElement).value).toBe('bash'),
    )
    expect(screen.getByTestId('provider-add')).toBeTruthy()
    const enabled = screen.getByLabelText('已启用') as HTMLInputElement
    expect(enabled.value).toBe('bash, read')
  })

  /**
   * 回归：此前导入无条件 `setDraft(导入值)`。用户在表单里存在未保存更改时，
   * 一次「⬆ 导入」选个文件就把整屏修改静默替换（保存条随即回到干净态，看不出
   * 发生过什么），而本页影响面更小的动作（切作用域 / 离开页面 / 删 MCP 行）
   * 都有二审——覆盖面最大的这次覆盖反而是唯一没有确认的。
   */
  it('有未保存更改时导入先确认：取消保留草稿，确认后才覆盖', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // 制造未保存更改：JSON 视图的合法改动会写入草稿
    fireEvent.click(screen.getByTestId('settings-mode-json'))
    const editor = screen.getByTestId('settings-json-editor') as HTMLTextAreaElement
    fireEvent.change(editor, {
      target: { value: JSON.stringify({ ...mockConfig, defaultModel: 'draft-model' }) },
    })
    expect(screen.getByTestId('settings-save')).not.toBeDisabled()

    const imported = { ...mockConfig, defaultModel: 'imported-model' }
    const mockFile = {
      text: () => Promise.resolve(JSON.stringify(imported)),
    } as unknown as File
    const input = screen.getByTestId('settings-import-input') as HTMLInputElement

    // 第一次：取消 → 草稿原样保留，没有被覆盖
    fireEvent.change(input, { target: { files: [mockFile] } })
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(screen.getByRole('dialog').textContent).toContain('未保存的更改')
    fireEvent.click(
      screen.getByRole('dialog').querySelector('[data-slot="cancel-button"]') as HTMLElement,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((screen.getByTestId('settings-json-editor') as HTMLTextAreaElement).value).toContain(
      'draft-model',
    )
    expect(screen.getByTestId('settings-save')).not.toBeDisabled()

    // 第二次：确认 → 导入值生效并切回表单
    fireEvent.change(input, { target: { files: [mockFile] } })
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    fireEvent.click(
      screen.getByRole('dialog').querySelector('[data-slot="confirm-button"]') as HTMLElement,
    )
    await waitFor(() => {
      const sel = screen.getByTestId('default-model-select') as HTMLSelectElement
      expect(sel.value).toBe('imported-model')
    })
  })

  it('JSON 视图结构不符时保存被拦下：不落盘坏形状', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('settings-mode-json'))
    const editor = screen.getByTestId('settings-json-editor') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '{"tools":"all"}' } })

    expect(screen.getByTestId('settings-json-error').textContent).toContain('tools')
    const save = screen.getByTestId('settings-save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(configAPI.update).not.toHaveBeenCalled()
    expect(screen.getByTestId('settings-save-blocked-hint').textContent).toContain('配置结构错误')
  })

  it('JSON 视图内容形状合法时切回表单会按当前配置补全（表单不读 undefined）', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('settings-mode-json'))
    const editor = screen.getByTestId('settings-json-editor') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '{"tools":{"disabled":["read"]}}' } })

    fireEvent.click(screen.getByTestId('settings-mode-gui'))
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())
    const enabled = screen.getByLabelText('已启用') as HTMLInputElement
    expect(enabled.value).toBe('bash, read')
    expect((screen.getByLabelText('已禁用') as HTMLInputElement).value).toBe('read')
  })

  /**
   * 回归：表单里取消勾选「一键提交使用独立模型」（commitModel: undefined）后，
   * JSON.stringify 会把值为 undefined 的键整条丢掉；切回表单时用已落盘 config
   * 当补全模板，正好把这个「用户刚做的删除」当成「文本里缺的键」补回旧值——
   * 复选框自己变回勾选，草稿与 config 又逐键相同，保存 diff 出空 patch 直接
   * 回显「✓ 已保存」，磁盘上什么都没变（实测：点保存零 PATCH 请求）。
   */
  it('表单里的 unset 活过 JSON 往返：勾选态保持未勾选，保存落成 null', async () => {
    const { configAPI } = await import('@/services/config.js')
    const withCommitModel = {
      ...mockConfig,
      commitModel: { provider: 'ProviderA', model: 'gpt-4' },
    }
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(withCommitModel))
    ;(configAPI.update as Mock).mockResolvedValue(withCommitModel)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    const cb = screen.getByLabelText(/一键提交使用独立模型/) as HTMLInputElement
    expect(cb.checked).toBe(true)
    fireEvent.click(cb)
    expect(cb.checked).toBe(false)

    fireEvent.click(screen.getByTestId('settings-mode-json'))
    const editor = screen.getByTestId('settings-json-editor') as HTMLTextAreaElement
    expect(editor.value).not.toContain('commitModel')

    fireEvent.click(screen.getByTestId('settings-mode-gui'))
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())
    expect((screen.getByLabelText(/一键提交使用独立模型/) as HTMLInputElement).checked).toBe(false)

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const patch = (configAPI.update as Mock).mock.calls[0]?.[0] as { commitModel?: unknown }
    // diffConfig 的清除口径：null（JSON 不传 undefined）
    expect(patch.commitModel).toBeNull()
  })

  /**
   * 回归：JSON 视图里把某段写成 null（校验放行，语义同 diffConfig 的「删除该键」）
   * 后切回表单，补全模板此前把这个 null 原样下发——归一化后 merged.compaction 为
   * null，面板按 Config 假定形状（compaction.compactionModel）当场抛错，整页被
   * ErrorBoundary 换成「页面渲染出错」，刚敲的草稿一起丢失。
   */
  it('JSON 里的 null 段切回表单不崩页：回落到当前值', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig({ ...mockConfig }))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('settings-mode-json'))
    const editor = screen.getByTestId('settings-json-editor') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '{"compaction":null,"theme":"dark"}' } })
    // null 段是合法的（清除该键），不该有结构错误挡住切回
    expect(screen.queryByTestId('settings-json-error')).toBeNull()

    fireEvent.click(screen.getByTestId('settings-mode-gui'))
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())
    // 表单仍完整可渲染，且该段按已加载配置回落（表单没有「未设置」这个可渲染值）
    expect((screen.getByLabelText('保留 Token') as HTMLInputElement).value).toBe('1000')
  })

  /**
   * 回归：commitModel 是可选键，当前配置没设过它时，JSON 里的 `"commitModel": null`
   * 会原样进表单（模板里没有形状可校验）。复选框此前只判 !== undefined，勾着；
   * 下面那个 provider/model 选择器又因为 null 是 falsy 不渲染——一个勾着却无从
   * 选择的开关。
   */
  it('JSON 里的 "commitModel": null（当前配置未设置该键）在表单里显示为未勾选', async () => {
    const { configAPI } = await import('@/services/config.js')
    const base = { ...mockConfig }
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(base))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('settings-mode-json'))
    const editor = screen.getByTestId('settings-json-editor') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: JSON.stringify({ ...base, commitModel: null }) } })
    fireEvent.click(screen.getByTestId('settings-mode-gui'))
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    expect((screen.getByLabelText(/一键提交使用独立模型/) as HTMLInputElement).checked).toBe(false)
  })
})

describe('Settings — 完整配置表单覆盖', () => {
  // 复现：配置作用域工具条用内联 flex 布局，标签 span 未禁止收缩，
  // 下拉随选项文案自适应后把它压到 57px，5 个汉字折成 2 行、盒子高 36px
  // （行高 18px 的两倍），工具条被单行标签撑成两行。标签同时缺少
  // 关联，select 无可访问名（axe critical select-name）。
  // 折行修复的样式由浏览器实测把关（见 scopeBar/scopeLabel），
  // jsdom 不求值 linaria 类，此处锁定可访问名契约。
  it('配置作用域下拉可按标签文案定位', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // axe select-name：裸 <span> 文本不构成 label，select 无可访问名。
    const select = screen.getByLabelText('配置作用域') as HTMLSelectElement
    expect(select).toBe(screen.getByTestId('scope-select'))
    expect(select).toHaveProperty('value', 'project')
  })

  it('所有配置分区均渲染', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    for (const title of [
      '外观',
      '默认 Provider / Model',
      'LLM Provider',
      '标题生成模型',
      '故障回退',
      '上下文压缩',
      '工具配置',
      '工具指标',
      '插件',
      '斜杠命令',
      'MCP 服务器',
      'Web 搜索',
      '工作流',
      '多 Agent',
      '安全',
      '自动授权',
    ]) {
      expect(headings).toContain(title)
    }
  })

  it('自动授权段落 select 切换并保存', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // 定位「自动授权」段落并取其内默认模式 select（段内现有两个下拉：模式 + 超时动作）
    const permHeading = screen
      .getAllByRole('heading', { level: 2 })
      .find((h) => h.textContent === '自动授权')
    expect(permHeading).toBeTruthy()
    const section = permHeading?.closest('div')
    const select = within(section as HTMLElement).getByLabelText(
      '默认授权模式',
    ) as HTMLSelectElement
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
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
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

  it('编辑上下文压缩单个字段后保存最小 diff（仅变化的键）', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // 修改保留 Token 数值（用 label 文本精确定位，避免与同值输入框混淆）
    const reserveLabel = screen.getByText('保留 Token').closest('label')
    const reserveInput = reserveLabel?.querySelector('input') as HTMLInputElement
    expect(reserveInput).toBeTruthy()
    fireEvent.change(reserveInput, { target: { value: '9999' } })

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      compaction: { reserveTokens: number; threshold?: number }
    }
    expect(args.compaction.reserveTokens).toBe(9999)
    // P1-2 diff：未变化的字段不进 patch（服务端按作用域合并保留其余值）
    expect(args.compaction.threshold).toBeUndefined()
  })

  it('勾选压缩独立模型后显示 provider/model 下拉并保存', async () => {
    const { configAPI } = await import('@/services/config.js')
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
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(cfg))
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

    // 切换到 Beta → model 自动校正为 b-1（model 下拉随 key 重挂载，需重新查询）
    fireEvent.change(providerSel, { target: { value: 'Beta' } })
    await waitFor(() => {
      const sel = screen.getByTestId('compaction-model-select') as HTMLSelectElement
      expect(sel.value).toBe('b-1')
    })

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      compaction: { compactionModel: { provider: string; model: string } }
    }
    expect(args.compaction.compactionModel).toEqual({ provider: 'Beta', model: 'b-1' })
  })

  it('取消勾选压缩独立模型后 compactionModel 被清除', async () => {
    const { configAPI } = await import('@/services/config.js')
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
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(cfg))
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
      compaction: { compactionModel?: { provider: string; model: string } | null }
    }
    // P1-2 diff：删除用 null 标记（服务端 unset 该作用域中的键）
    expect(args.compaction.compactionModel).toBeNull()
    // 最小 patch：compaction 其余未变键不出现
    expect(Object.keys(args.compaction)).toEqual(['compactionModel'])
  })

  it('删除 MCP 服务器需二次确认：取消保留、确认才移除', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('mcp-add'))
    expect(screen.getAllByTestId('mcp-row')).toHaveLength(1)

    // 回归：删除此前单击即生效，一行已填好的 command/args/url 直接消失。
    // 点删除后必须先出现确认弹层，行仍在。
    fireEvent.click(screen.getByTestId('mcp-remove'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('MCP 服务器')
    expect(screen.getAllByTestId('mcp-row')).toHaveLength(1)

    // 取消：行保留
    fireEvent.click(within(dialog).getByText('取消'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getAllByTestId('mcp-row')).toHaveLength(1)

    // 确认：行才移除
    fireEvent.click(screen.getByTestId('mcp-remove'))
    const dialog2 = await screen.findByRole('dialog')
    fireEvent.click(within(dialog2).getByText('删除'))
    await waitFor(() => expect(screen.queryByTestId('mcp-row')).toBeNull())
  })

  // 复现：args 字段是 value={args.join(' ')} + onChange=v.split(/\s+/) 的裸受控组合，
  // 每敲一个空格就被 parse→join 还原，尾随分隔符永远打不出来——第二个参数根本输不进去，
  // 用户以为填的是 `npx -y`，保存下来是 `npx-y`。
  it('MCP args 空格分隔：尾随空格保留，第二个参数能输进去', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(configAPI.update as Mock).mockResolvedValue({ ok: true })

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('mcp-add'))
    const args = screen.getByPlaceholderText('args（空格分隔）') as HTMLInputElement
    fireEvent.change(args, { target: { value: 'npx ' } })
    await waitFor(() => expect(args.value).toBe('npx '))

    fireEvent.change(args, { target: { value: 'npx -y' } })
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const patch = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      mcpServers: { args: string[] }[]
    }
    expect(patch.mcpServers[0]?.args).toEqual(['npx', '-y'])
  })

  // 回归：MCP 已在 serve/CLI 两个宿主接入（registerMCPServers 注册其工具、项目作用域
  // 受信任门禁），面板却仍写「未接入工具加载…不会向 AI 暴露任何工具」——用户据此刻意
  // 不配置、或以为配了也无副作用（实际会连服务器并暴露工具）。提示必须与实现一致。
  it('MCP 面板提示与实现一致（不谎称未接入）', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    const notice = screen.getByTestId('mcp-scope-notice').textContent ?? ''
    expect(notice).not.toContain('未接入')
    expect(notice).not.toContain('功能未生效')
    expect(notice).toContain('信任')
  })

  // 复现：数字输入框把文本直接 `Number(v)`——'1e999' 折成 Infinity 进 draft，
  // diff 出的 patch 里是 Infinity，JSON 序列化（fetch body）后变 null，服务端
  // applyScopedPatch 视 null 为「取消该键」：月度预算被静默删除（护栏关闭），
  // UI 却回显「已保存」。
  it('预算输入非法数值（1e999）不会把 Infinity 写进 patch', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(configAPI.update as Mock).mockResolvedValue({ ok: true })

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    const input = screen.getByTestId('usage-global-token-budget')
    fireEvent.change(input, { target: { value: '1e999' } })
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())

    const patch = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      usage?: { globalMonthlyTokenBudget?: unknown }
    }
    const value = patch.usage?.globalMonthlyTokenBudget
    expect(value === undefined || Number.isFinite(value)).toBe(true)
  })

  it('启用安全认证后显示 Token 输入框', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // security 仅全局作用域生效：切到全局作用域后字段才可编辑
    fireEvent.change(screen.getByTestId('scope-select'), { target: { value: 'global' } })

    // 初始 authEnabled=false，Token 输入框不显示
    expect(screen.queryByPlaceholderText('Bearer Token')).toBeNull()

    // 勾选启用认证
    const authCheck = screen
      .getAllByRole('checkbox')
      .find((cb) => cb.closest('label')?.textContent?.includes('Bearer Token 认证'))
    expect(authCheck).toBeTruthy()
    fireEvent.click(authCheck as HTMLElement)

    await waitFor(() => expect(screen.getByPlaceholderText('Bearer Token')).toBeTruthy())
  })

  it('项目作用域下安全字段禁用并提示切全局作用域', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // 默认作用域为 project：安全字段禁用 + 提示
    expect(screen.getByTestId('security-scope-hint')).toBeTruthy()
    const authCheck = screen
      .getAllByRole('checkbox')
      .find((cb) =>
        cb.closest('label')?.textContent?.includes('Bearer Token 认证'),
      ) as HTMLInputElement
    expect(authCheck.disabled).toBe(true)
    // 自动授权（permission）仍是项目级可编辑，不受影响
    const permSelect = screen.getByLabelText('默认授权模式') as HTMLSelectElement
    expect(permSelect.disabled).toBe(false)

    // 切到全局作用域后安全字段解禁、提示消失
    fireEvent.change(screen.getByTestId('scope-select'), { target: { value: 'global' } })
    expect(screen.queryByTestId('security-scope-hint')).toBeNull()
    const authCheckGlobal = screen
      .getAllByRole('checkbox')
      .find((cb) =>
        cb.closest('label')?.textContent?.includes('Bearer Token 认证'),
      ) as HTMLInputElement
    expect(authCheckGlobal.disabled).toBe(false)
  })

  it('关闭认证需确认：取消不生效，确认后写入 security 变更', async () => {
    const { configAPI } = await import('@/services/config.js')
    const withAuth = { ...mockConfig, security: { authEnabled: true, allowedOrigins: [] } }
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(withAuth))
    ;(configAPI.update as Mock).mockResolvedValue(withAuth)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // security 仅全局作用域生效：切到全局作用域后字段才可编辑
    fireEvent.change(screen.getByTestId('scope-select'), { target: { value: 'global' } })

    const authCheck = screen
      .getAllByRole('checkbox')
      .find((cb) =>
        cb.closest('label')?.textContent?.includes('Bearer Token 认证'),
      ) as HTMLInputElement
    expect(authCheck.checked).toBe(true)

    // 取消勾选 → ConfirmDialog 二审；取消 → 变更不生效
    fireEvent.click(authCheck)
    const authDialog = screen.getByRole('dialog')
    expect(authDialog.textContent).toContain('关闭认证将移除所有 API 鉴权')
    fireEvent.click(authDialog.querySelector('[data-slot="cancel-button"]') as HTMLElement)
    expect(authCheck.checked).toBe(true)
    expect(screen.getByTestId('settings-save')).toBeDisabled()

    // 再次取消勾选 → 确认关闭
    fireEvent.click(authCheck)
    fireEvent.click(
      screen.getByRole('dialog').querySelector('[data-slot="confirm-button"]') as HTMLElement,
    )
    expect(authCheck.checked).toBe(false)

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as {
      security: { authEnabled?: boolean; token?: unknown }
    }
    expect(args.security.authEnabled).toBe(false)
    // 最小 patch：security 内仅 authEnabled 变化
    expect(Object.keys(args.security)).toEqual(['authEnabled'])
  })

  it('保存 security 变更后显示重启提示（needsRestart）', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(configAPI.update as Mock).mockResolvedValue({
      config: mockConfig,
      scopes: { global: null, project: null },
      warnings: [],
      needsRestart: true,
    })

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // security 仅全局作用域生效：切到全局作用域后字段才可编辑
    fireEvent.change(screen.getByTestId('scope-select'), { target: { value: 'global' } })

    const authCheck = screen
      .getAllByRole('checkbox')
      .find((cb) => cb.closest('label')?.textContent?.includes('Bearer Token 认证')) as HTMLElement
    fireEvent.click(authCheck) // 启用认证（开启方向无需确认）

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(screen.getByTestId('settings-restart-hint')).toBeTruthy())
    expect(screen.getByTestId('settings-restart-hint').textContent).toContain('重启')
  })

  // 回归：needsRestart 提示排在 <SettingsSaveBar> 之后、DOM 最末端，而保存条是
  // position:sticky;bottom:0 恒钉视口底部。GUI 表单实测高 3500px+，于是这条
  // 「还没生效」的提示永远落在滚动区最末尾：用户点完保存，视口里只有「✓ 已保存」，
  // 把「已保存」和「已加固」混为一谈。提示必须与保存状态同处一屏。
  it('重启提示钉在吸底保存条上（与保存状态同屏），不随文档滚到最末尾', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(configAPI.update as Mock).mockResolvedValue({
      config: mockConfig,
      scopes: { global: null, project: null },
      warnings: [],
      needsRestart: true,
    })

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.change(screen.getByTestId('scope-select'), { target: { value: 'global' } })
    const authCheck = screen
      .getAllByRole('checkbox')
      .find((cb) => cb.closest('label')?.textContent?.includes('Bearer Token 认证')) as HTMLElement
    fireEvent.click(authCheck)
    fireEvent.click(screen.getByTestId('settings-save'))

    await waitFor(() => expect(screen.getByTestId('settings-restart-hint')).toBeTruthy())

    // 提示必须挂在保存条内部（sticky 区域内），而不是它的下一个兄弟节点
    const bar = screen.getByTestId('settings-save-bar')
    expect(bar.contains(screen.getByTestId('settings-restart-hint'))).toBe(true)
    // 文案要说明「配置已存下但未生效」，否则与「✓ 已保存」并列仍会被读成已加固
    expect(screen.getByTestId('settings-restart-hint').textContent).toContain('未生效')
  })

  // 回归：needsRestart 是**每次 PATCH 各自**的信号（服务端只在本次写入
  // security/update/plugins 且作用域为 global 时返回 true）。覆盖式置位让
  // 「鉴权改动尚未生效」的唯一警告被下一次无关保存（改默认模型，返回 false）
  // 抹掉——用户据此认定鉴权已加固。
  it('后续无关保存不得抹掉已有的「需重启」提示', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    const update = configAPI.update as Mock
    // 第一次：security 变更 → 需要重启；第二次：无关变更 → 服务端返回 false
    update.mockResolvedValueOnce({
      config: mockConfig,
      scopes: { global: null, project: null },
      warnings: [],
      needsRestart: true,
    })
    update.mockResolvedValue({
      config: mockConfig,
      scopes: { global: null, project: null },
      warnings: [],
      needsRestart: false,
    })

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.change(screen.getByTestId('scope-select'), { target: { value: 'global' } })
    const authCheck = screen
      .getAllByRole('checkbox')
      .find((cb) => cb.closest('label')?.textContent?.includes('Bearer Token 认证')) as HTMLElement
    fireEvent.click(authCheck)
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(screen.getByTestId('settings-restart-hint')).toBeTruthy())

    // 顺手改一个无关项再保存：重启提示必须还在
    fireEvent.change(screen.getByTestId('default-model-select'), { target: { value: 'gpt-5' } })
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))

    expect(screen.getByTestId('settings-restart-hint')).toBeTruthy()
  })

  it('最小 patch：只保存变化字段，未变化的顶层键不出现在 payload', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // 只修改 defaultModel
    fireEvent.change(screen.getByTestId('default-model-select'), { target: { value: 'gpt-5' } })

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const args = (configAPI.update as Mock).mock.calls[0]?.[0] as Record<string, unknown>
    expect(Object.keys(args).sort()).toEqual(['defaultModel'])
  })

  it('切换 Web 搜索后端并保存', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
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
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    const concurrencyLabel = screen.getByText('子 Agent 并发数').closest('label')
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
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    const enabledLabel = screen.getByText('已启用').closest('label')
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

describe('Settings — 吸底保存条与未保存导航防护', () => {
  /** 制造未保存更改的稳定控件：故障回退启用开关（此前用 role-add，已随任意角色 UI 移除）。 */
  const dirtyTrigger = (): HTMLElement =>
    screen
      .getAllByRole('checkbox')
      .find((cb) => cb.closest('label')?.textContent?.includes('启用自动重试与回退')) as HTMLElement

  it('修改字段后保存条出现「未保存更改」提示与「放弃更改」，未修改时弱化', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(dirtyTrigger()).toBeTruthy())

    // 初始干净状态：保存条在底部但禁用，无提示无放弃按钮
    expect(screen.getByTestId('settings-save-bar')).toBeTruthy()
    expect(screen.getByTestId('settings-save')).toBeDisabled()
    expect(screen.queryByTestId('settings-dirty-hint')).toBeNull()
    expect(screen.queryByTestId('settings-discard')).toBeNull()

    // 修改字段 → dirty：提示与放弃按钮出现，保存可用
    fireEvent.click(dirtyTrigger())
    expect(screen.getByTestId('settings-dirty-hint').textContent).toContain('未保存更改')
    expect(screen.getByTestId('settings-discard')).toBeTruthy()
    expect(screen.getByTestId('settings-save')).not.toBeDisabled()
  })

  it('点击「放弃更改」清空草稿，表单恢复到已保存配置', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    fireEvent.click(screen.getByTestId('provider-add'))
    expect(screen.getAllByTestId('provider-row')).toHaveLength(3)

    fireEvent.click(screen.getByTestId('settings-discard'))

    expect(screen.getByTestId('settings-save')).toBeDisabled()
    expect(screen.queryByTestId('settings-dirty-hint')).toBeNull()
    expect(screen.queryByTestId('settings-discard')).toBeNull()
    // 新增的空 provider 行随草稿一起回退
    expect(screen.getAllByTestId('provider-row')).toHaveLength(2)
  })

  it('保存请求在途时「放弃更改」被锁死：草稿不被清空，期间的新编辑不丢', async () => {
    // 回归：提交出去的是点击保存那一刻的草稿引用。请求在途时按「放弃更改」
    // 会把草稿清空 → 在途请求照旧把内容落盘 → 吸底条随后显示「✓ 已保存」，
    // 用户看着像回滚了，实际配置已改、期间新打的字还被他这句「放弃」吞掉。
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    let release: (() => void) | null = null
    ;(configAPI.update as Mock).mockReturnValue(
      new Promise<void>((res) => {
        release = () => res()
      }),
    )

    renderSettings()
    await waitFor(() => expect(dirtyTrigger()).toBeTruthy())

    fireEvent.click(dirtyTrigger()) // 制造未保存更改
    fireEvent.click(screen.getByTestId('settings-save'))

    // 在途：两个键都不可用
    await waitFor(() =>
      expect(screen.getByTestId('settings-save-bar').textContent).toContain('保存中'),
    )
    expect(screen.getByTestId('settings-save')).toBeDisabled()
    expect(screen.getByTestId('settings-discard')).toBeDisabled()

    fireEvent.click(screen.getByTestId('settings-discard'))
    expect(screen.getByTestId('settings-dirty-hint')).toBeTruthy()

    await act(async () => {
      release?.()
      await Promise.resolve()
    })

    // 落地后恢复可放弃
    await waitFor(() =>
      expect(screen.getByTestId('settings-save-bar').textContent).toContain('已保存'),
    )
    expect((screen.getByTestId('settings-discard') as HTMLButtonElement).disabled).toBe(false)
  })

  it('dirty 时点击离开设置页的站内链接弹确认，「留下」则留在设置页', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettingsGuarded()
    await waitFor(() => expect(dirtyTrigger()).toBeTruthy())

    fireEvent.click(dirtyTrigger()) // 制造未保存更改

    fireEvent.click(screen.getByTestId('leave-link'))

    // veto 挂起 → 确认弹窗出现，导航未提交（仍渲染 Settings）
    await waitFor(() => expect(screen.getByTestId('settings-unsaved-dialog')).toBeTruthy())
    expect(screen.queryByTestId('project-view')).toBeNull()

    fireEvent.click(screen.getByTestId('settings-unsaved-stay'))

    expect(screen.queryByTestId('settings-unsaved-dialog')).toBeNull()
    expect(screen.queryByTestId('project-view')).toBeNull() // 仍停留在设置页
    expect(screen.getByTestId('settings-dirty-hint')).toBeTruthy() // 草稿保留
  })

  it('确认「离开」丢弃草稿并放行被拦截的链接点击', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettingsGuarded()
    await waitFor(() => expect(dirtyTrigger()).toBeTruthy())

    fireEvent.click(dirtyTrigger()) // 制造未保存更改

    fireEvent.click(screen.getByTestId('leave-link'))
    await waitFor(() => expect(screen.getByTestId('settings-unsaved-dialog')).toBeTruthy())

    fireEvent.click(screen.getByTestId('settings-unsaved-leave'))

    // proceed 重放导航：草稿丢弃、设置页卸载、目标视图落地
    await waitFor(() => expect(screen.getByTestId('project-view')).toBeTruthy())
    expect(screen.queryByTestId('settings-unsaved-dialog')).toBeNull()
    expect(screen.queryByTestId('settings')).toBeNull()
  })

  it('干净状态点击站内链接不弹确认；dirty 时刷新被 beforeunload 拦截，放弃后解除', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettingsGuarded()
    await waitFor(() => expect(dirtyTrigger()).toBeTruthy())

    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)

    // dirty：beforeunload 被 preventDefault
    fireEvent.click(dirtyTrigger())
    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)

    // 放弃更改后解除防护
    fireEvent.click(screen.getByTestId('settings-discard'))
    const after = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)

    // 干净状态：站内链接直接放行（无确认弹窗），目标视图落地
    fireEvent.click(screen.getByTestId('leave-link'))
    expect(screen.queryByTestId('settings-unsaved-dialog')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('project-view')).toBeTruthy())
  })
})

describe('Settings — 用量面板预算字段与写入作用域一致', () => {
  it('/settings 默认项目作用域下锁定全局预算字段，切到全局后可编辑并提交 global 作用域', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(configAPI.update as Mock).mockResolvedValue(mockConfig)

    renderSettings()
    // 回归：此前这里是可编辑的「全局月度预算」，而默认作用域是「项目」——
    // 编辑后保存被服务端 400（GLOBAL_BUDGET_IN_PROJECT_SCOPE）拒绝，整次保存
    // 连同其中其他改动一起失败。
    const globalBudget = (await screen.findByTestId('usage-global-budget')) as HTMLInputElement
    expect(globalBudget.disabled).toBe(true)
    expect(screen.getByTestId('usage-scope-hint').textContent).toContain('全局')
    expect(screen.getByTestId('usage-no-budget-hint')).toBeTruthy()

    // 正解路径：把作用域切到「全局配置」即可编辑——此时保存也必须按 global 提交。
    fireEvent.change(screen.getByTestId('scope-select'), { target: { value: 'global' } })
    await waitFor(() => expect(screen.queryByTestId('usage-scope-hint')).toBeNull())
    const editable = screen.getByTestId('usage-global-budget') as HTMLInputElement
    expect(editable.disabled).toBe(false)

    fireEvent.change(editable, { target: { value: '10' } })
    await waitFor(() => expect(screen.queryByTestId('usage-no-budget-hint')).toBeNull())

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const [patchArg, scopeArg] = (configAPI.update as Mock).mock.calls[0] as [
      { usage?: Record<string, number> },
      string,
    ]
    expect(scopeArg).toBe('global')
    expect(patchArg.usage).toEqual({ globalMonthlyBudgetUsd: 10 })
  })

  it('项目页切到全局作用域后，项目预算字段被锁定（否则会把本项目预算写进全局配置）', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue({
      config: mockConfig,
      projectDir: '/x/y/proj',
      scopes: { global: {}, project: {} },
      warnings: [],
    })

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <MemoryRouter routes={settingsTestRoutes} initialEntries={['/projects/p1/settings']}>
        <QueryClientProvider client={qc}>
          <View />
        </QueryClientProvider>
      </MemoryRouter>,
    )

    const projectBudget = (await screen.findByTestId('usage-project-budget')) as HTMLInputElement
    expect(projectBudget.disabled).toBe(false)

    fireEvent.change(screen.getByTestId('scope-select'), { target: { value: 'global' } })
    await waitFor(() =>
      expect((screen.getByTestId('usage-project-budget') as HTMLInputElement).disabled).toBe(true),
    )
    expect(screen.getByTestId('usage-scope-hint').textContent).toContain('项目')
  })
})

describe('Settings — 工作流管理面板', () => {
  const WF_FIXTURES = [
    { name: 'security-audit', description: '内置审计', source: 'builtin', overrides: null },
    {
      name: 'my-wf',
      description: '自定义工作流',
      source: 'user',
      overrides: 'builtin' as const,
    },
  ]

  it('渲染工作流列表：来源徽标 + 覆盖徽标，内置行无编辑/删除', async () => {
    const { configAPI } = await import('@/services/config.js')
    const { workflowsAPI } = await import('@/services/workflows.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(workflowsAPI.list as Mock).mockResolvedValue({ workflows: WF_FIXTURES })

    renderSettings()
    await waitFor(() => expect(screen.getAllByTestId('workflow-row')).toHaveLength(2))

    expect(screen.getByText('内置')).toBeTruthy()
    expect(screen.getByText('用户')).toBeTruthy()
    // 项目级工作流同名覆盖内置时明示「覆盖内置」
    expect(screen.getByText('覆盖内置')).toBeTruthy()

    const builtinRow = screen.getByText('security-audit').closest('[data-testid="workflow-row"]')
    expect(within(builtinRow as HTMLElement).queryByTestId('workflow-edit')).toBeNull()
    expect(within(builtinRow as HTMLElement).queryByTestId('workflow-delete')).toBeNull()
    expect(within(builtinRow as HTMLElement).queryByTestId('workflow-view')).toBeTruthy()
  })

  it('新建工作流：非法名称被拒；合法名称保存（无项目上下文默认 target=user）', async () => {
    const { configAPI } = await import('@/services/config.js')
    const { workflowsAPI } = await import('@/services/workflows.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(workflowsAPI.list as Mock).mockResolvedValue({ workflows: [] })
    ;(workflowsAPI.save as Mock).mockResolvedValue({ ok: true })

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('workflow-add')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workflow-add'))

    // 非法名称（大写/下划线）被拒，不发起请求
    fireEvent.change(screen.getByTestId('workflow-name-input'), { target: { value: 'Bad_Name' } })
    fireEvent.click(screen.getByTestId('workflow-save'))
    await waitFor(() =>
      expect(screen.getByTestId('workflow-panel-error').textContent).toContain('不合法'),
    )
    expect(workflowsAPI.save).not.toHaveBeenCalled()

    fireEvent.change(screen.getByTestId('workflow-name-input'), { target: { value: 'my-wf' } })
    fireEvent.click(screen.getByTestId('workflow-save'))
    await waitFor(() => expect(workflowsAPI.save).toHaveBeenCalled())
    // mutationFn 首参为 payload（react-query 会把 context 作为第二参传入）
    const payload = (workflowsAPI.save as Mock).mock.calls[0]?.[0] as {
      name: string
      source: string
      target: string
    }
    expect(payload.name).toBe('my-wf')
    expect(payload.target).toBe('user')
    expect(payload.source).toContain('export default async function workflow')
  })

  it('删除工作流：必须输入确认词才可确认，成功后调用 remove', async () => {
    const { configAPI } = await import('@/services/config.js')
    const { workflowsAPI } = await import('@/services/workflows.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(workflowsAPI.list as Mock).mockResolvedValue({
      workflows: [WF_FIXTURES[1]],
    })
    ;(workflowsAPI.remove as Mock).mockResolvedValue({ ok: true })

    renderSettings()
    await waitFor(() => expect(screen.getAllByTestId('workflow-row')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('workflow-delete'))

    const confirmBtn = screen.getByTestId('danger-confirm-btn') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('danger-confirm-input'), { target: { value: 'my-wf' } })
    expect((screen.getByTestId('danger-confirm-btn') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('danger-confirm-btn'))
    await waitFor(() =>
      expect(workflowsAPI.remove).toHaveBeenCalledWith('my-wf', undefined, 'user'),
    )
  })

  // 删除失败的原因此前只写进 section 顶部的 workflow-panel-error，而删除确认是
  // <dialog> 模态——那条错误在遮罩之下，用户看到的是「弹窗原地不动、框内零提示」。
  // 契约：失败原因留在用户正在做的操作旁边（DangerConfirmDialog 的 error 槽）。
  it('删除工作流失败：原因显示在确认弹窗内，弹窗不自己关掉', async () => {
    const { configAPI } = await import('@/services/config.js')
    const { workflowsAPI } = await import('@/services/workflows.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(workflowsAPI.list as Mock).mockResolvedValue({ workflows: [WF_FIXTURES[1]] })
    ;(workflowsAPI.remove as Mock).mockRejectedValue(new Error('工作流文件被占用'))

    renderSettings()
    await waitFor(() => expect(screen.getAllByTestId('workflow-row')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('workflow-delete'))
    fireEvent.change(screen.getByTestId('danger-confirm-input'), { target: { value: 'my-wf' } })
    fireEvent.click(screen.getByTestId('danger-confirm-btn'))

    await waitFor(() =>
      expect(screen.getByTestId('danger-error').textContent).toContain('工作流文件被占用'),
    )
    // 失败不是「成功」：弹窗仍在，用户可以改环境后重试或取消
    expect(screen.getByTestId('danger-confirm-dialog')).toBeTruthy()

    // 关掉再重开：上一条失败原因不残留（否则看起来像这次也会失败）
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByTestId('danger-confirm-dialog')).toBeNull())
    fireEvent.click(screen.getByTestId('workflow-delete'))
    expect(screen.queryByTestId('danger-error')).toBeNull()
  })

  it('编辑工作流保存带 overwrite: true；新建不带 overwrite', async () => {
    const { configAPI } = await import('@/services/config.js')
    const { workflowsAPI } = await import('@/services/workflows.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(workflowsAPI.list as Mock).mockResolvedValue({ workflows: [WF_FIXTURES[1]] })
    ;(workflowsAPI.get as Mock).mockResolvedValue({
      ...WF_FIXTURES[1],
      sourceCode: 'export const meta = { name: "my-wf" }\n',
    })
    ;(workflowsAPI.save as Mock).mockResolvedValue({ ok: true })

    renderSettings()
    await waitFor(() => expect(screen.getAllByTestId('workflow-row')).toHaveLength(1))

    // 编辑模式：overwrite: true（源码读取完成前「保存」禁用）
    fireEvent.click(screen.getByTestId('workflow-edit'))
    await waitFor(() =>
      expect((screen.getByTestId('workflow-save') as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId('workflow-save'))
    await waitFor(() => expect(workflowsAPI.save).toHaveBeenCalled())
    const editPayload = (workflowsAPI.save as Mock).mock.calls.at(-1)?.[0] as {
      overwrite?: boolean
    }
    expect(editPayload.overwrite).toBe(true)

    // 新建模式：不带 overwrite（服务端 409 防误覆盖）
    ;(workflowsAPI.save as Mock).mockClear()
    fireEvent.click(screen.getByTestId('workflow-add'))
    fireEvent.change(screen.getByTestId('workflow-name-input'), { target: { value: 'new-wf' } })
    fireEvent.click(screen.getByTestId('workflow-save'))
    await waitFor(() => expect(workflowsAPI.save).toHaveBeenCalled())
    const createPayload = (workflowsAPI.save as Mock).mock.calls.at(-1)?.[0] as {
      overwrite?: boolean
    }
    expect(createPayload.overwrite).toBeUndefined()
  })

  // 复现：openEdit 沿用上一次的 draftSource 就开窗，弹窗标题写「编辑：B」而编辑区
  // 里还是 A 的源码，且「保存」不感知加载态——慢盘下点保存就用 A 覆盖 B（overwrite: true）。
  it('编辑弹窗在源码加载完成前不展示上一个工作流的内容、也不可保存', async () => {
    const { configAPI } = await import('@/services/config.js')
    const { workflowsAPI } = await import('@/services/workflows.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(workflowsAPI.list as Mock).mockResolvedValue({ workflows: WF_FIXTURES })
    ;(workflowsAPI.save as Mock).mockResolvedValue({ ok: true })

    // 第一次查看立即返回，源码进入 draft；第二次（编辑）挂起不返回
    type Detail = { name: string; sourceCode: string }
    let resolveSlow: ((v: Detail) => void) | undefined
    ;(workflowsAPI.get as Mock).mockImplementation((name: string) =>
      name === 'security-audit'
        ? Promise.resolve({ ...WF_FIXTURES[0], sourceCode: 'const A = 1\n' })
        : new Promise<Detail>((r) => {
            resolveSlow = r
          }),
    )

    renderSettings()
    await waitFor(() => expect(screen.getAllByTestId('workflow-row')).toHaveLength(2))

    // 内置行只有「查看」；用 my-wf 走一遍加载完成 → 关闭，让 draft 里有内容
    fireEvent.click(screen.getAllByTestId('workflow-view')[0] as HTMLElement)
    await waitFor(() =>
      expect((screen.getByTestId('workflow-source-editor') as HTMLTextAreaElement).value).toBe(
        'const A = 1\n',
      ),
    )
    fireEvent.click(screen.getByLabelText('关闭'))

    // 第二次打开（挂起中）：编辑区必须为空、保存禁用
    fireEvent.click(screen.getByTestId('workflow-edit'))
    const editor = (await screen.findByTestId('workflow-source-editor')) as HTMLTextAreaElement
    expect(editor.value).toBe('')
    expect(screen.getByTestId('workflow-loading')).toBeTruthy()
    expect((screen.getByTestId('workflow-save') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('workflow-save'))
    expect(workflowsAPI.save).not.toHaveBeenCalled()

    // 读取完成 → 源码出现、保存可用
    resolveSlow?.({ name: 'my-wf', sourceCode: 'const B = 2\n' })
    await waitFor(() =>
      expect((screen.getByTestId('workflow-source-editor') as HTMLTextAreaElement).value).toBe(
        'const B = 2\n',
      ),
    )
    expect(screen.queryByTestId('workflow-loading')).toBeNull()
    expect((screen.getByTestId('workflow-save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('未信任项目：list 返回 trustRequired 时展示隐藏提示', async () => {
    const { configAPI } = await import('@/services/config.js')
    const { workflowsAPI } = await import('@/services/workflows.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(workflowsAPI.list as Mock).mockResolvedValue({
      workflows: [WF_FIXTURES[0]],
      trustRequired: true,
    })

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('workflow-trust-required')).toBeTruthy())
    expect(screen.getByTestId('workflow-trust-required').textContent).toContain('未信任')
  })
})

/**
 * 分区导航（TOC）回归。
 *
 * 设置页是全应用最长的一页：GUI 模式 18 个 h2 分区、实测 scrollHeight 3369px
 * （移动端 3898px），而页面原先没有任何分区内导航——找「用量与成本」「Web 搜索」
 * 只能一路滚到底。?section= 深链只解决「从别处跳进来」，解决不了
 * 「已经在这页、想换个分区」。
 */
describe('Settings — 分区导航', () => {
  it('表单视图渲染分区目录，条目数与实际 h2 分区一致', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('settings-toc')).toBeTruthy())

    const chips = within(screen.getByTestId('settings-toc')).getAllByRole('button')
    const headings = within(screen.getByTestId('settings-form')).getAllByRole('heading', {
      level: 2,
    })
    // 目录是扫描 h2 得来的，两者必须逐条对应——多一条是死链，少一条是漏项
    expect(chips).toHaveLength(headings.length)
    expect(headings.length).toBeGreaterThan(10)
    expect(chips.map((c) => c.textContent)).toEqual(headings.map((h) => h.textContent))
  })

  it('分区目录是导航语义，且每个条目都能定位到对应分区', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('settings-toc')).toBeTruthy())

    expect(screen.getByRole('navigation', { name: '设置分区导航' })).toBeTruthy()

    const chips = within(screen.getByTestId('settings-toc')).getAllByRole('button')
    for (const chip of chips) {
      const id = chip.getAttribute('data-testid')?.replace('settings-toc-', '') ?? ''
      // 点它得找得到落点，否则就是个点了没反应的死链
      expect(document.getElementById(id)).not.toBeNull()
    }
  })

  it('JSON 视图不渲染分区目录（整块是一个编辑器，没有分区可导）', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

    renderSettings()
    await waitFor(() => expect(screen.getByTestId('settings-toc')).toBeTruthy())

    fireEvent.click(screen.getByText('{ } JSON'))
    await waitFor(() => expect(screen.queryByTestId('settings-toc')).toBeNull())
  })

  // 落点被 sticky 完全遮住 = 「点了但什么都没变」：标题藏在两条栏底下，肉眼
  // 只看到工具条、目录行和它们的下一个分区。
  //
  // 两条 sticky 是叠加的，各自让开一条都不够：
  // 1. 原先写死 `offsetTop - 16` 只让开了工具条，标题停在目录行底下；
  // 2. 改让两条后还要等目录行挂载——目录行由 SettingsToc 扫描完 h2 才
  //    渲染，而深链 effect 与那次扫描同批跑，那一刻目录行尚未入 DOM，
  //    实测高度为 0。
  // 实测（1440px）两种漏法分别让「上下文压缩」标题落在 y=61 与 y=104，
  // 目录行下沿在 141——都被完全遮住。
  describe('深链与目录跳转落在 sticky 之下', () => {
    /** 工具条实测高度（1440px 宽）。 */
    const TOOLBAR_H = 51
    /** 目录行实测高度。 */
    const TOC_H = 45
    /** 两条 sticky 的下沿。 */
    const LINE = TOOLBAR_H + TOC_H
    /** 「上下文压缩」h2 在容器内的文档纵坐标（实测 offsetTop 1122）。 */
    const COMPACTION_TOP = 1122

    /**
     * happy-dom 无布局引擎，这里造出设置页真实的几何关系：
     * 视口坐标 = 容器内文档坐标 - main.scrollTop。两条 sticky 固定贴顶。
     *
     * 只认「表单子树里 h2 的文档坐标」这一条规则——真实布局正是这样：h2 分散
     * 在各面板组件内、嵌套深度各不相同，所以实现只能统一走视口坐标。
     */
    function stubLayout(main: HTMLElement) {
      const base = { x: 0, left: 0, right: 1440, width: 1440, toJSON: () => ({}) }
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element,
      ) {
        const h = this.tagName === 'H2' ? this.textContent?.trim() : null
        if (h === '上下文压缩') {
          const top = COMPACTION_TOP - main.scrollTop
          return { ...base, y: top, top, bottom: top + 22, height: 22 } as DOMRect
        }
        if (this === main) return { ...base, y: 0, top: 0, bottom: 856, height: 856 } as DOMRect
        if (this.getAttribute('data-testid') === 'settings-toolbar')
          return { ...base, y: 0, top: 0, bottom: TOOLBAR_H, height: TOOLBAR_H } as DOMRect
        if (this.getAttribute('data-testid') === 'settings-toc')
          return { ...base, y: TOOLBAR_H, top: TOOLBAR_H, bottom: LINE, height: TOC_H } as DOMRect
        return { ...base, y: 0, top: 0, bottom: 0, height: 0 } as DOMRect
      })
    }

    /** 在 <main> 滚动容器里挂载设置页（生产结构：内容在 main 内滚）。 */
    function renderInScroller(entry: string) {
      const main = document.createElement('main')
      document.body.appendChild(main)
      stubLayout(main)
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      render(
        <MemoryRouter routes={settingsTestRoutes} initialEntries={[entry]}>
          <QueryClientProvider client={qc}>
            <View />
          </QueryClientProvider>
        </MemoryRouter>,
        { container: main },
      )
      return main
    }

    it('?section= 深链把标题让到工具条+目录行下沿之外', async () => {
      const { configAPI } = await import('@/services/config.js')
      ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

      const main = renderInScroller('/settings?section=section-5-上下文压缩')
      await waitFor(() => expect(screen.getByTestId('settings-toc')).toBeTruthy())
      const heading = screen.getByRole('heading', { level: 2, name: '上下文压缩' })
      await waitFor(() => expect(heading).toBeTruthy())

      // 断言「没被遮住」这个用户可观测结果，而不是 scrollTop 的具体数值：
      // 标题视口坐标须落在两条 sticky 下沿之下。
      const top = COMPACTION_TOP - main.scrollTop
      expect(
        top,
        `深链落点 y=${top} 须 ≥ sticky 下沿 ${LINE}，否则标题被完全遮住`,
      ).toBeGreaterThanOrEqual(LINE)
      vi.restoreAllMocks()
    })

    // useSearchParams 每次渲染都 `new URLSearchParams(...)`（@native-router/react
    // dist/use-search-params.js），深链 effect 若把那个对象放进依赖，就会逐渲染
    // 重跑；jump → scrollSettingsSectionIntoView 无条件 `scrollTop += delta`，
    // 于是只要 URL 里留着 ?section=，用户滚到别的分区一敲字就被拽回锚点分区，
    // 输入框逐字跳出视口。依赖必须是稳定的锚点字符串。
    it('URL 带 ?section= 时，编辑其它分区不会把页面拽回锚点', async () => {
      const { configAPI } = await import('@/services/config.js')
      ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

      const main = renderInScroller('/settings?section=section-5-上下文压缩')
      await waitFor(() => expect(screen.getByTestId('settings-toc')).toBeTruthy())
      // 「上下文压缩」分区里的自动压缩开关：任何一次编辑都会 setDraft →
      // Settings 重渲染，正是当年把用户拽回锚点的触发条件。
      const toggle = await screen.findByRole('checkbox', { name: '启用自动压缩' })

      // 用户滚去另一个分区（深链落点之后的文档坐标）
      const awayFromAnchor = COMPACTION_TOP + 400
      main.scrollTop = awayFromAnchor
      expect(main.scrollTop).toBe(awayFromAnchor)

      // 在那儿改一个字段——触发 Settings 重渲染
      fireEvent.click(toggle)
      await waitFor(() => expect(screen.getByTestId('settings-toc')).toBeTruthy())

      expect(
        main.scrollTop,
        `编辑后 scrollTop 变成 ${main.scrollTop}，用户被拽离正在编辑的位置`,
      ).toBe(awayFromAnchor)
      vi.restoreAllMocks()
    })

    it('点击目录条与深链落到同一位置（落点口径不分叉）', async () => {
      const { configAPI } = await import('@/services/config.js')
      ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))

      // 先取「上下文压缩」这一项的稳定 id
      renderInScroller('/settings')
      await waitFor(() => expect(screen.getByTestId('settings-toc')).toBeTruthy())
      const chip = within(screen.getByTestId('settings-toc'))
        .getAllByRole('button')
        .find((b) => b.textContent === '上下文压缩')
      expect(chip).toBeTruthy()
      const id = chip?.getAttribute('data-testid')?.replace('settings-toc-', '')
      cleanup()
      vi.restoreAllMocks()

      // 同一分区：深链进入
      const byLink = renderInScroller(`/settings?section=${encodeURIComponent(id ?? '')}`)
      await waitFor(() => expect(screen.getByTestId('settings-toc')).toBeTruthy())
      const linkScroll = byLink.scrollTop
      cleanup()
      vi.restoreAllMocks()

      // 同一分区：点目录进入
      const byClick = renderInScroller('/settings')
      await waitFor(() => expect(screen.getByTestId('settings-toc')).toBeTruthy())
      const same = within(screen.getByTestId('settings-toc'))
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-testid') === `settings-toc-${id}`)
      fireEvent.click(same as HTMLElement)
      const clickScroll = byClick.scrollTop
      vi.restoreAllMocks()

      expect(linkScroll, '深链与点击目录应落在同一位置').toBe(clickScroll)
    })
  })

  /**
   * 目录行的滚轮换算。
   *
   * 缺陷：目录行是 overflow-x:auto，但鼠标滚轮只有纵向分量。实测滚轮停在目录行
   * 上时 scrollLeft 恒为 0、页面纵向滚了 300px——目录行在鼠标用户眼里不能滑。
   * 1024px 下 18 个分区有 6 个（安全/自动授权/用量与成本/工作流/多 Agent/…）
   * 因此够不到。
   *
   * 关键不是「能不能滚」，而是「什么时候必须把滚轮还回去」：滚到两端还继续拦截，
   * 用户会在目录行上卡住——怎么滚页面都不动，比滑不动更糟。
   */
  describe('目录行滚轮横向滑动', () => {
    const bar = { scrollLeft: 300, scrollWidth: 1467, clientWidth: 1024 }

    const wheel = (deltaX: number, deltaY: number, deltaMode = 0) => ({
      deltaX,
      deltaY,
      deltaMode,
    })

    it('纵向滚轮转成目录行横向滚动', () => {
      expect(horizontalWheelTarget(bar, wheel(0, 120))).toBe(420)
    })

    it('已到最左且继续上滚时放行，让页面自己滚', () => {
      expect(horizontalWheelTarget({ ...bar, scrollLeft: 0 }, wheel(0, -120))).toBeNull()
    })

    it('已到最右且继续下滚时放行，不把用户卡在目录行上', () => {
      const max = bar.scrollWidth - bar.clientWidth
      expect(horizontalWheelTarget({ ...bar, scrollLeft: max }, wheel(0, 120))).toBeNull()
    })

    it('没有横向溢出时一律不拦截', () => {
      expect(
        horizontalWheelTarget(
          { scrollLeft: 0, scrollWidth: 1024, clientWidth: 1024 },
          wheel(0, 120),
        ),
      ).toBeNull()
    })

    it('落点被钳在 [0, max] 内，不会滚出边界', () => {
      const max = bar.scrollWidth - bar.clientWidth
      expect(horizontalWheelTarget({ ...bar, scrollLeft: max - 10 }, wheel(0, 500))).toBe(max)
      expect(horizontalWheelTarget({ ...bar, scrollLeft: 10 }, wheel(0, -500))).toBe(0)
    })

    it('触控板横向手势优先于纵向分量', () => {
      expect(horizontalWheelTarget(bar, wheel(-200, 5))).toBe(100)
    })

    it('deltaMode 为行数时按行高折算（Firefox 报行数，当像素用会几乎不动）', () => {
      // DOM_DELTA_LINE=1：5 行 → 80px
      expect(horizontalWheelTarget(bar, wheel(0, 5, 1))).toBe(380)
      // DOM_DELTA_PIXEL=0：5 就是 5px——同一手势差 16 倍，不折算等于滑不动
      expect(horizontalWheelTarget(bar, wheel(0, 5, 0))).toBe(305)
    })
  })
})

/**
 * 数字字段的越界输入回归。
 *
 * 缺陷：数字输入框上写了 min={0}，但 React 受控 input 不阻止键入负数——
 * parseFiniteNumber 只挡 NaN/±Infinity，不挡越界值，于是 -1 被原样写进配置。
 * 实测 8 个带 min 的字段（最大重试次数/重试间隔/触发阈值/保留 Token/
 * 近期保留 Token/成功率阈值/最小样本数/子 Agent 并发数）全部照收。
 *
 * 后果不是显示难看而是静默失效：maxRetries=-1 让 withRetry 的
 * `attempt >= Math.min(-1, policy.maxRetries)` 首次失败即成立，故障回退对
 * 全应用停摆，而设置页照样显示「已保存」。
 *
 * 断言打在「保存出去的配置值」上：只看输入框 DOM 会被 SyncedInput 的内部
 * control 短暂持有旧值骗过去，必须走真实的保存链路。
 */
describe('Settings — 数字字段越界钳制', () => {
  async function typeAndSave(labelText: string, raw: string) {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue(wrapConfig(mockConfig))
    ;(configAPI.update as Mock).mockResolvedValue({ ok: true })

    renderSettings()
    const input = await screen.findByLabelText(labelText)

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, raw)
    fireEvent.input(input)

    await waitFor(() => expect(screen.getByTestId('settings-save')).not.toBeDisabled())
    fireEvent.click(screen.getByTestId('settings-save'))

    await waitFor(() => expect(configAPI.update).toHaveBeenCalled())
    const patch = vi.mocked(configAPI.update).mock.calls.at(-1)?.[0] as Record<string, unknown>
    return patch
  }

  it('最大重试次数不接受负数（负值会静默关掉全应用故障回退）', async () => {
    const patch = await typeAndSave('最大重试次数', '-1')
    const fallback = (patch.fallback ?? {}) as { maxRetries?: number }
    expect(fallback.maxRetries).toBe(0)
  })

  it('子 Agent 并发数下限为 1，0/负数被钳到 1', async () => {
    const patch = await typeAndSave('子 Agent 并发数', '0')
    const agents = (patch.agents ?? {}) as { subagentConcurrency?: number }
    expect(agents.subagentConcurrency).toBe(1)
  })

  it('触发阈值上限为 1，超出被钳回 1', async () => {
    const patch = await typeAndSave('触发阈值', '5')
    const compaction = (patch.compaction ?? {}) as { threshold?: number }
    expect(compaction.threshold).toBe(1)
  })

  it('合法值原样通过，不被钳制误伤', async () => {
    const patch = await typeAndSave('最大重试次数', '5')
    const fallback = (patch.fallback ?? {}) as { maxRetries?: number }
    expect(fallback.maxRetries).toBe(5)
  })
})

/**
 * 撤销设备失败必须可见。
 *
 * 缺陷：revoke mutation 只有 onSuccess，且 onConfirm 里 mutate 后立刻关弹窗。
 * 请求失败时列表不变、页面零提示——而弹窗里刚承诺「该设备将立即失去访问权限」，
 * 用户据此以为撤销成功，那台设备其实仍持有访问权。这是与语义相反的假成功
 * （ProjectIndicator 删除失败 / WorkflowsPanel 删除失败都已给出原因行）。
 */
describe('Settings — 撤销设备失败', () => {
  it('撤销失败时给出原因，且不谎称已撤销', async () => {
    const { configAPI } = await import('@/services/config.js')
    const { authAPI } = await import('../services/auth.js')
    // 设备列表只在启用认证后渲染（SecurityPanel 以 authEnabled 为前置条件）
    ;(configAPI.get as Mock).mockResolvedValue(
      wrapConfig({ ...mockConfig, security: { authEnabled: true, allowedOrigins: [] } }),
    )
    ;(authAPI.listDevices as Mock).mockResolvedValue({
      devices: [{ id: 'dev-1', name: '我的笔记本', createdAt: '2024-01-01T00:00:00.000Z' }],
    })
    ;(authAPI.revokeDevice as Mock).mockRejectedValue(new Error('认证服务不可用'))

    renderSettings()

    const revokeBtn = await screen.findByRole('button', { name: '撤销' })
    fireEvent.click(revokeBtn)

    fireEvent.click(await screen.findByRole('button', { name: '撤销设备' }))

    const alert = await screen.findByTestId('device-revoke-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain('认证服务不可用')
    // 设备仍在列表里（列表未被乐观移除）
    expect(screen.getByTestId('device-list').textContent).toContain('我的笔记本')
  })
})

/**
 * 已授权设备列表读失败必须给出原因与重试。
 *
 * 缺陷：isError 分支只渲染一句灰字「获取已授权设备失败（认证可能未启用）」——
 * 后端原因（500 / 超时 / 无权）被丢掉，没有任何重试入口，还把一次读取失败断言成
 * 「认证可能未启用」（而认证明明开着：用户正站在「已授权设备」这一段里）。同一次
 * 读取的设备列表与「撤销」入口一起静默失效。与 UsagePanel / WorkflowsPanel 的
 * 「原因 + 重试」同口径。
 */
describe('Settings — 已授权设备读取失败', () => {
  it('给出后端原因与重试入口，且不再猜「认证可能未启用」', async () => {
    const { configAPI } = await import('@/services/config.js')
    const { authAPI } = await import('../services/auth.js')
    ;(configAPI.get as Mock).mockResolvedValue(
      wrapConfig({ ...mockConfig, security: { authEnabled: true, allowedOrigins: [] } }),
    )
    ;(authAPI.listDevices as Mock).mockRejectedValue(new Error('devices boom'))

    renderSettings()

    const box = await screen.findByTestId('device-list-error')
    expect(box.getAttribute('role')).toBe('alert')
    expect(box.textContent).toContain('devices boom')
    expect(screen.queryByText(/认证可能未启用/)).toBeNull()
    expect(screen.getByTestId('device-list-retry')).toBeTruthy()
  })

  it('点重试重新拉取，成功后渲染设备列表', async () => {
    const { configAPI } = await import('@/services/config.js')
    const { authAPI } = await import('../services/auth.js')
    ;(configAPI.get as Mock).mockResolvedValue(
      wrapConfig({ ...mockConfig, security: { authEnabled: true, allowedOrigins: [] } }),
    )
    ;(authAPI.listDevices as Mock)
      .mockRejectedValueOnce(new Error('devices boom'))
      .mockResolvedValue({
        devices: [{ id: 'dev-1', name: '我的笔记本', createdAt: '2024-01-01T00:00:00.000Z' }],
      })

    renderSettings()

    fireEvent.click(await screen.findByTestId('device-list-retry'))

    const list = await screen.findByTestId('device-list')
    expect(list.textContent).toContain('我的笔记本')
    expect(screen.queryByTestId('device-list-error')).toBeNull()
  })
})

/**
 * 回归：工具条右侧的「目标：…」是唯一显式声明「这次保存写到哪个文件」的提示。
 * 此前它的渲染条件只判 projectId && resp.projectDir，与作用域无关——切到
 * 「全局配置（~/.c0de/config.json）」后仍标「目标：<项目目录>」，而保存其实
 * 写进全局配置：用户据此以为改的是项目文件，把项目专属值（路径、模型名）
 * 提升成全机默认，其他项目与 c0de chat 一起被改。
 */
describe('Settings — 写入目标标注随作用域变化', () => {
  function renderProjectSettings() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <MemoryRouter routes={settingsTestRoutes} initialEntries={['/projects/p1/settings']}>
        <QueryClientProvider client={qc}>
          <View />
        </QueryClientProvider>
      </MemoryRouter>,
    )
  }

  it('项目作用域标注项目目录，切到全局后改写全局配置路径', async () => {
    const { configAPI } = await import('@/services/config.js')
    ;(configAPI.get as Mock).mockResolvedValue({
      config: mockConfig,
      projectDir: '/x/y/proj',
      scopes: { global: {}, project: {} },
      warnings: [],
    })

    renderProjectSettings()
    await waitFor(() => expect(screen.getByTestId('provider-add')).toBeTruthy())

    // 默认 project：目标指向项目目录
    expect(screen.getByText('目标：/x/y/proj')).toBeTruthy()

    // 切到 global：目标必须改成全局配置路径——不能继续指向项目目录，
    // 否则用户以为在改项目文件，实际写进 ~/.c0de/config.json。
    fireEvent.change(screen.getByTestId('scope-select'), { target: { value: 'global' } })
    expect(screen.queryByText('目标：/x/y/proj')).toBeNull()
    expect(screen.getByText('目标：~/.c0de/config.json')).toBeTruthy()
  })
})

/**
 * 斜杠命令开关与命令浮层同源。
 *
 * 缺陷：useCommands 的 queryKey ['commands'] 是 staleTime: Infinity，而服务端
 * GET /api/commands 按 config.slashCommands.enabled 过滤（启用才返回）。设置页保存
 * 只失效了 ['config'] 这一路缓存，于是本会话内的 / 浮层永不刷新：禁用一个命令后
 * 浮层照旧列出它（点进去服务端回「未启用」，看着像命令坏了），启用一个命令后浮层
 * 里永远不出现（功能不可达），唯一出路是整页刷新。
 */
describe('Settings — 保存后斜杠命令浮层数据同源刷新', () => {
  function renderSettingsWithCommandsProbe() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <MemoryRouter routes={settingsTestRoutes} initialEntries={['/settings']}>
        <QueryClientProvider client={qc}>
          <View />
          <CommandsProbe />
        </QueryClientProvider>
      </MemoryRouter>,
    )
  }

  function CommandsProbe() {
    const commands = useCommands()
    return (
      <div data-testid="commands-probe">{(commands.data ?? []).map((c) => c.name).join(',')}</div>
    )
  }

  it('保存斜杠命令开关后浮层数据失效重取（不再需要整页刷新）', async () => {
    const { configAPI } = await import('@/services/config.js')
    const { commandsAPI } = await import('@/services/commands.js')
    ;(configAPI.get as Mock).mockResolvedValue(
      wrapConfig({ ...mockConfig, slashCommands: { enabled: ['/clear', '/model'] } }),
    )
    // 服务端语义：按「已启用的斜杠命令」过滤（这里用一份全量清单模拟 registry）
    const registry = [
      { name: 'clear', description: '清空会话' },
      { name: 'model', description: '查看模型' },
    ]
    let enabled = ['/clear', '/model']
    ;(configAPI.update as Mock).mockImplementation(async (patch: Partial<Config>) => {
      const next = (patch as { slashCommands?: { enabled?: string[] } }).slashCommands?.enabled
      if (next) enabled = next
      return { ...mockConfig, config: undefined }
    })
    ;(commandsAPI.list as Mock).mockImplementation(async () => ({
      commands: enabled.includes('*')
        ? registry
        : registry.filter((c) => enabled.includes(`/${c.name}`)),
    }))

    renderSettingsWithCommandsProbe()
    await waitFor(() =>
      expect(screen.getByTestId('commands-probe').textContent).toBe('clear,model'),
    )

    // 只留 /model 并保存
    fireEvent.change(screen.getByLabelText('已启用的斜杠命令'), { target: { value: '/model' } })
    fireEvent.click(screen.getByTestId('settings-save'))

    await waitFor(() => expect(screen.getByTestId('commands-probe').textContent).toBe('model'))
  })
})
