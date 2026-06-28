// ProviderCatalogDialog 组件测试，对应 src/web/components/ProviderCatalogDialog.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderCatalogDialog } from './ProviderCatalogDialog.js'

vi.mock('../services/catalog.js', () => ({
  catalogAPI: {
    listProviders: vi.fn(),
    getProviderModels: vi.fn(),
    search: vi.fn(),
    refresh: vi.fn(),
  },
}))

const { catalogAPI } = await import('../services/catalog.js')

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

  it('确认选择后回调正确 protocol 和 baseURL', async () => {
    const onSelect = vi.fn()
    vi.mocked(catalogAPI.listProviders).mockResolvedValue({
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          npm: '@ai-sdk/openai',
          api: 'https://api.openai.com/v1',
          env: ['OPENAI_API_KEY'],
          modelCount: 1,
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
        modelCount: 1,
      },
      models: [],
    })

    renderWithClient(<ProviderCatalogDialog onClose={vi.fn()} onSelect={onSelect} />)

    await waitFor(() => {
      expect(screen.getByText('OpenAI')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('catalog-provider-openai'))
    fireEvent.click(screen.getByTestId('catalog-confirm'))

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith({
        name: 'OpenAI',
        protocol: 'openai',
        baseURL: 'https://api.openai.com/v1',
        apiKey: '',
      })
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
})
