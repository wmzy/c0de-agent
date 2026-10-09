// ProviderCatalogDialog 组件测试，对应 src/web/components/ProviderCatalogDialog.tsx
import type { ProviderConfig } from '@shared/types/llm.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderCatalogDialog } from '@/components/ProviderCatalogDialog.js'

vi.mock('@/services/catalog.js', () => ({
  catalogAPI: {
    listProviders: vi.fn(),
    getProviderModels: vi.fn(),
    search: vi.fn(),
    refresh: vi.fn(),
  },
}))

const { catalogAPI } = await import('@/services/catalog.js')

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('ProviderCatalogDialog', () => {
  it('渲染 provider 列表', async () => {
    vi.mocked(catalogAPI.listProviders).mockResolvedValue({
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          npm: '@ai-sdk/openai',
          api: 'https://api.openai.com/v1',
          env: ['OPENAI_API_KEY'],
          modelCount: 10,
        },
        {
          id: 'anthropic',
          name: 'Anthropic',
          npm: '@ai-sdk/anthropic',
          api: 'https://api.anthropic.com',
          env: ['ANTHROPIC_API_KEY'],
          modelCount: 5,
        },
      ],
    })

    renderWithClient(<ProviderCatalogDialog onClose={vi.fn()} onSelect={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('OpenAI')).toBeTruthy()
      expect(screen.getByText('Anthropic')).toBeTruthy()
    })
  })

  it('搜索过滤 provider 列表', async () => {
    vi.mocked(catalogAPI.listProviders).mockResolvedValue({
      providers: [
        { id: 'openai', name: 'OpenAI', npm: '@ai-sdk/openai', env: [], modelCount: 10 },
        { id: 'anthropic', name: 'Anthropic', npm: '@ai-sdk/anthropic', env: [], modelCount: 5 },
      ],
    })

    renderWithClient(<ProviderCatalogDialog onClose={vi.fn()} onSelect={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('OpenAI')).toBeTruthy()
    })

    fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'anthro' } })

    await waitFor(() => {
      expect(screen.queryByText('OpenAI')).toBeNull()
      expect(screen.getByText('Anthropic')).toBeTruthy()
    })
  })

  it('选择 provider 后显示模型列表', async () => {
    vi.mocked(catalogAPI.listProviders).mockResolvedValue({
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          npm: '@ai-sdk/openai',
          api: 'https://api.openai.com/v1',
          env: ['OPENAI_API_KEY'],
          modelCount: 2,
        },
      ],
    })
    vi.mocked(catalogAPI.getProviderModels).mockResolvedValue({
      provider: {
        id: 'openai',
        name: 'OpenAI',
        npm: '@ai-sdk/openai',
        api: 'https://api.openai.com/v1',
        env: ['OPENAI_API_KEY'],
        modelCount: 2,
      },
      models: [
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          reasoning: false,
          toolCall: true,
          attachment: true,
          temperature: true,
          context: 128000,
          output: 16384,
        },
        {
          id: 'o1',
          name: 'o1',
          reasoning: true,
          toolCall: false,
          attachment: false,
          temperature: false,
          context: 200000,
          output: 100000,
        },
      ],
    })

    renderWithClient(<ProviderCatalogDialog onClose={vi.fn()} onSelect={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('OpenAI')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('catalog-provider-openai'))

    await waitFor(() => {
      expect(screen.getByText('GPT-4o')).toBeTruthy()
      expect(screen.getAllByText('o1').length).toBeGreaterThanOrEqual(1)
    })
    // 工具标签
    expect(screen.getByText('工具')).toBeTruthy()
    expect(screen.getByText('推理')).toBeTruthy()
  })

  it('确认选择后回调正确 protocol、baseURL 和模型 capabilities', async () => {
    const onSelect = vi.fn()
    vi.mocked(catalogAPI.listProviders).mockResolvedValue({
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          npm: '@ai-sdk/openai',
          api: 'https://api.openai.com/v1',
          env: ['OPENAI_API_KEY'],
          modelCount: 2,
        },
      ],
    })
    vi.mocked(catalogAPI.getProviderModels).mockResolvedValue({
      provider: {
        id: 'openai',
        name: 'OpenAI',
        npm: '@ai-sdk/openai',
        api: 'https://api.openai.com/v1',
        env: ['OPENAI_API_KEY'],
        modelCount: 2,
      },
      models: [
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          reasoning: false,
          toolCall: true,
          attachment: true,
          temperature: true,
          context: 128000,
          output: 16384,
          costInput: 2.5,
          costOutput: 10,
        },
        {
          id: 'o1',
          name: 'o1',
          reasoning: true,
          toolCall: false,
          attachment: false,
          temperature: false,
          context: 200000,
          output: 100000,
        },
      ],
    })

    renderWithClient(<ProviderCatalogDialog onClose={vi.fn()} onSelect={onSelect} />)

    await waitFor(() => {
      expect(screen.getByText('OpenAI')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('catalog-provider-openai'))
    // 等待模型列表加载完成后再确认
    await waitFor(() => {
      expect(screen.getByText('GPT-4o')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('catalog-confirm'))

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledTimes(1)
    })
    const result = onSelect.mock.calls[0]?.[0] as ProviderConfig
    expect(result.name).toBe('OpenAI')
    expect(result.protocol).toBe('openai')
    expect(result.baseURL).toBe('https://api.openai.com/v1')
    expect(result.apiKey).toBe('')
    // 模型 capabilities 从 models.dev 自动填充
    expect(result.models).toEqual({
      'gpt-4o': {
        contextWindow: 128000,
        maxOutput: 16384,
        supportsTools: true,
        supportsVision: true,
        supportsThinking: false,
        costPer1kInput: 0.0025,
        costPer1kOutput: 0.01,
      },
      o1: {
        contextWindow: 200000,
        maxOutput: 100000,
        supportsTools: false,
        supportsVision: false,
        supportsThinking: true,
      },
    })
  })

  it('取消按钮关闭弹窗', async () => {
    const onClose = vi.fn()
    vi.mocked(catalogAPI.listProviders).mockResolvedValue({ providers: [] })

    renderWithClient(<ProviderCatalogDialog onClose={onClose} onSelect={vi.fn()} />)

    fireEvent.click(screen.getByText('取消'))
    expect(onClose).toHaveBeenCalled()
  })

  it('未选择 provider 时确认按钮禁用', async () => {
    vi.mocked(catalogAPI.listProviders).mockResolvedValue({
      providers: [{ id: 'openai', name: 'OpenAI', npm: '@ai-sdk/openai', env: [], modelCount: 1 }],
    })

    renderWithClient(<ProviderCatalogDialog onClose={vi.fn()} onSelect={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('OpenAI')).toBeTruthy()
    })

    const confirmBtn = screen.getByTestId('catalog-confirm') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
  })

  // 搜索是「看什么」、选择是「要什么」：输入一个不包含已选项的搜索词，
  // 选中态此前被静默作废（确认键无声禁用、详情标题退化成裸 id、API/文档链接消失）。
  it('搜索词过滤掉已选 provider 时，选择与确认按钮仍然有效', async () => {
    vi.mocked(catalogAPI.listProviders).mockResolvedValue({
      providers: [
        { id: 'openai', name: 'OpenAI', npm: '@ai-sdk/openai', env: [], modelCount: 2 },
        { id: 'anthropic', name: 'Anthropic', npm: '@ai-sdk/anthropic', env: [], modelCount: 3 },
      ],
    })
    vi.mocked(catalogAPI.getProviderModels).mockResolvedValue({
      provider: {
        id: 'openai',
        name: 'OpenAI',
        npm: '@ai-sdk/openai',
        env: [],
        modelCount: 1,
      },
      models: [
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          attachment: false,
          reasoning: false,
          temperature: true,
          toolCall: true,
          context: 128000,
          output: 16384,
          costInput: 1,
          costOutput: 2,
        },
      ],
    })

    renderWithClient(<ProviderCatalogDialog onClose={vi.fn()} onSelect={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('OpenAI')).toBeTruthy())
    fireEvent.click(screen.getByTestId('catalog-provider-openai'))
    await waitFor(() => expect(screen.getByText('GPT-4o')).toBeTruthy())

    fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'anthro' } })

    await waitFor(() => expect(screen.queryByTestId('catalog-provider-openai')).toBeNull())
    // 选择没被搜索词作废：确认键仍可点、详情仍是 OpenAI（不是裸 id）
    expect((screen.getByTestId('catalog-confirm') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('catalog-confirm').textContent).toContain('选择此 Provider')
    expect(screen.getByTestId('catalog-kept-selection').textContent).toContain('OpenAI')
    expect(screen.getByText('GPT-4o')).toBeTruthy()
  })

  it('搜索无命中时给出「无匹配」而不是一片空白', async () => {
    vi.mocked(catalogAPI.listProviders).mockResolvedValue({
      providers: [{ id: 'openai', name: 'OpenAI', npm: '@ai-sdk/openai', env: [], modelCount: 1 }],
    })

    renderWithClient(<ProviderCatalogDialog onClose={vi.fn()} onSelect={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('OpenAI')).toBeTruthy())

    fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'zzz' } })

    await waitFor(() => expect(screen.getByTestId('catalog-no-match')).toBeTruthy())
    expect(screen.getByTestId('catalog-no-match').textContent).toContain('zzz')
  })
})
