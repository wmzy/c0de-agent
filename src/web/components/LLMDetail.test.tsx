import type { LLMDetail } from '@shared/types/agent.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LLMDetailPanel } from './LLMDetail.js'
import { LLMDetailsView } from './LLMDetailsView.js'

vi.mock('../services/session.js', () => ({
  sessionAPI: {
    llmDetails: vi.fn(),
  },
}))

// 引用被 mock 的 sessionAPI，用于在每个用例里指定返回值。
const { sessionAPI } = await import('../services/session.js')

const detail: LLMDetail = {
  id: 'd1',
  timestamp: 1,
  model: 'gpt-4',
  provider: 'openai',
  role: { _tag: 'default' },
  systemPrompt: 'You are helpful',
  messages: [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc-1', name: 'read', arguments: '{"path":"a.ts"}' }],
    },
    {
      role: 'tool',
      content: 'file contents',
      toolCallId: 'tc-1',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'see image' },
        { type: 'image', mediaType: 'image/png', data: 'base64...' },
      ],
    },
  ],
  tools: [
    {
      name: 'read',
      description: '读取文件内容',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
    {
      name: 'edit',
      description: '编辑文件',
      parameters: { type: 'object', properties: {} },
    },
  ],
  responseChunks: [{ _tag: 'text', text: 'hello' }],
  usage: { input: 10, output: 5 },
  latency: { firstToken: 100, total: 1500 },
  cost: 0.001,
}

const emptyDetail: LLMDetail = {
  ...detail,
  id: 'd2',
  messages: [],
  tools: [],
}

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('LLMDetailPanel', () => {
  afterEach(() => cleanup())

  it('渲染模型名和 provider', () => {
    render(<LLMDetailPanel detail={detail} />)
    const el = screen.getByTestId('llm-detail')
    expect(el.textContent).toContain('gpt-4')
    expect(el.textContent).toContain('openai')
  })

  it('渲染 token 用量和格式化延迟', () => {
    render(<LLMDetailPanel detail={detail} />)
    const el = screen.getByTestId('llm-detail')
    expect(el.textContent).toContain('10')
    expect(el.textContent).toContain('5')
    expect(el.textContent).toContain('1.50s')
  })

  it('Messages 面板标题显示消息条数', () => {
    render(<LLMDetailPanel detail={detail} />)
    expect(screen.getByTestId('messages-summary').textContent).toContain('Messages (4)')
  })

  it('渲染每条消息的 role 与文本内容', () => {
    const { container } = render(<LLMDetailPanel detail={detail} />)
    const text = container.textContent ?? ''
    expect(text).toContain('hello')
    expect(text).toContain('file contents')
    // role 标签
    expect(text).toContain('user')
    expect(text).toContain('assistant')
    expect(text).toContain('tool')
  })

  it('Messages 以原始 JSON 展示，含 toolCalls', () => {
    const { container } = render(<LLMDetailPanel detail={detail} />)
    const text = container.textContent ?? ''
    // toolCalls 的 name 与 arguments（JSON.stringify 会转义内部引号）
    expect(text).toContain('"name": "read"')
    expect(text).toContain('a.ts')
  })

  it('多模态 content 以原始 JSON 展示 image 结构', () => {
    const { container } = render(<LLMDetailPanel detail={detail} />)
    expect(container.textContent).toContain('"mediaType": "image/png"')
  })

  it('Tools 面板标题显示工具条数', () => {
    render(<LLMDetailPanel detail={detail} />)
    expect(screen.getByTestId('tools-summary').textContent).toContain('Tools (2)')
  })

  it('渲染每个工具的名称、描述和 parameters', () => {
    const { container } = render(<LLMDetailPanel detail={detail} />)
    const text = container.textContent ?? ''
    expect(text).toContain('读取文件内容')
    expect(text).toContain('编辑文件')
    expect(text).toContain('"properties"')
  })

  it('消息为空时显示空态', () => {
    render(<LLMDetailPanel detail={emptyDetail} />)
    expect(screen.getByTestId('messages-summary').textContent).toContain('Messages (0)')
  })

  it('工具为空时显示空态', () => {
    render(<LLMDetailPanel detail={emptyDetail} />)
    expect(screen.getByTestId('tools-summary').textContent).toContain('Tools (0)')
  })

  it('渲染模型角色和调用花费', () => {
    render(<LLMDetailPanel detail={detail} />)
    const el = screen.getByTestId('llm-detail')
    expect(el.textContent).toContain('default')
    expect(el.textContent).toContain('$0.0010')
  })

  it('折叠区块默认折叠，点击后切换为展开', () => {
    render(<LLMDetailPanel detail={detail} />)
    const btn = screen.getByTestId('messages-summary')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
  })

  it('存在 thinking 时渲染 Thinking 区块', () => {
    const withThinking: LLMDetail = { ...detail, id: 'd3', thinking: '逐步推理过程' }
    const { container } = render(<LLMDetailPanel detail={withThinking} />)
    expect(container.textContent).toContain('Thinking')
    expect(container.textContent).toContain('逐步推理过程')
  })

  it('无 thinking 时不渲染 Thinking 区块', () => {
    const { container } = render(<LLMDetailPanel detail={detail} />)
    expect(container.textContent).not.toContain('Thinking')
  })
})

describe('LLMDetailsView', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('默认折叠，不渲染详情列表', () => {
    ;(sessionAPI.llmDetails as Mock).mockResolvedValue([])
    renderWithClient(<LLMDetailsView sessionId="s1" />)
    expect(screen.queryByTestId('llm-details-list')).toBeNull()
    expect(screen.getByTestId('llm-details-toggle').textContent).toContain('调用详情 (0)')
  })

  it('展开后渲染每条 LLM 调用详情', async () => {
    ;(sessionAPI.llmDetails as Mock).mockResolvedValue([detail])
    renderWithClient(<LLMDetailsView sessionId="s1" />)
    fireEvent.click(screen.getByTestId('llm-details-toggle'))
    await waitFor(() => {
      expect(screen.getAllByTestId('llm-detail')).toHaveLength(1)
    })
  })

  it('无数据时显示空态文案', async () => {
    ;(sessionAPI.llmDetails as Mock).mockResolvedValue([])
    renderWithClient(<LLMDetailsView sessionId="s1" />)
    fireEvent.click(screen.getByTestId('llm-details-toggle'))
    await waitFor(() => {
      expect(screen.getByText('暂无 LLM 调用记录')).toBeTruthy()
    })
  })

  it('toggle 按钮反映详情条数', async () => {
    ;(sessionAPI.llmDetails as Mock).mockResolvedValue([detail, emptyDetail])
    renderWithClient(<LLMDetailsView sessionId="s1" />)
    await waitFor(() => {
      expect(screen.getByTestId('llm-details-toggle').textContent).toContain('调用详情 (2)')
    })
  })

  it('多条调用时只展示最后一次，不逐条渲染', async () => {
    ;(sessionAPI.llmDetails as Mock).mockResolvedValue([detail, emptyDetail])
    renderWithClient(<LLMDetailsView sessionId="s1" />)
    fireEvent.click(screen.getByTestId('llm-details-toggle'))
    await waitFor(() => {
      expect(screen.getAllByTestId('llm-detail')).toHaveLength(1)
    })
  })
})
