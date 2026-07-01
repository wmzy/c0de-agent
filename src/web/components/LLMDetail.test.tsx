import type { LLMCall, LLMSegment } from '@shared/types/agent.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CallRow, SegmentHeader } from './LLMDetail.js'
import { LLMDetailsView } from './LLMDetailsView.js'

vi.mock('../services/session.js', () => ({
  sessionAPI: {
    llmDetails: vi.fn(),
  },
}))

// 引用被 mock 的 sessionAPI，用于在每个用例里指定返回值。
const { sessionAPI } = await import('../services/session.js')

const tools: LLMSegment['tools'] = [
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
]

const call: LLMCall = {
  id: 'c1',
  timestamp: 1,
  usage: { input: 10, output: 5 },
  latency: { firstToken: 100, total: 1500 },
  cost: 0.001,
  responseText: 'hello',
}

const segment: LLMSegment = {
  id: 's1',
  fingerprint: 'fp',
  provider: 'openai',
  model: 'gpt-4',
  systemPrompt: 'You are helpful',
  tools,
  startedAt: 1,
  trigger: 'initial',
  contextWindow: 8000,
  calls: [call],
}

const emptySegment: LLMSegment = { ...segment, id: 's2', tools: [], calls: [] }

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('SegmentHeader', () => {
  afterEach(() => cleanup())

  it('渲染 model / provider / trigger', () => {
    render(<SegmentHeader segment={segment} />)
    const el = screen.getByTestId('segment-header')
    expect(el.textContent).toContain('gpt-4')
    expect(el.textContent).toContain('openai')
    expect(el.textContent).toContain('initial')
  })

  it('Tools 面板标题显示工具条数', () => {
    render(<SegmentHeader segment={segment} />)
    expect(screen.getByTestId('tools-summary').textContent).toContain('Tools (2)')
  })

  it('渲染每个工具的名称、描述和 parameters', () => {
    const { container } = render(<SegmentHeader segment={segment} />)
    const text = container.textContent ?? ''
    expect(text).toContain('读取文件内容')
    expect(text).toContain('编辑文件')
    expect(text).toContain('"properties"')
  })

  it('工具为空时显示空态', () => {
    render(<SegmentHeader segment={emptySegment} />)
    expect(screen.getByTestId('tools-summary').textContent).toContain('Tools (0)')
  })

  it('System Prompt 可折叠展示', () => {
    const { container } = render(<SegmentHeader segment={segment} />)
    // 默认折叠：内容不在可见渲染中（仍常驻 DOM，但折叠态）；展开后可见
    expect(container.textContent).toContain('You are helpful')
  })
})

describe('CallRow', () => {
  afterEach(() => cleanup())

  it('渲染 responseText', () => {
    render(<CallRow call={call} index={1} />)
    const el = screen.getByTestId('call-row')
    expect(el.textContent).toContain('hello')
  })

  it('渲染 token 用量和格式化延迟', () => {
    render(<CallRow call={call} index={1} />)
    const el = screen.getByTestId('call-row')
    expect(el.textContent).toContain('10')
    expect(el.textContent).toContain('5')
    expect(el.textContent).toContain('1.50s')
    expect(el.textContent).toContain('$0.0010')
  })

  it('渲染调用序号', () => {
    render(<CallRow call={call} index={3} />)
    expect(screen.getByTestId('call-row').textContent).toContain('调用 #3')
  })

  it('有 thinking 时渲染 Thinking 区块', () => {
    const withThinking: LLMCall = { ...call, id: 'c2', thinking: '逐步推理过程' }
    const { container } = render(<CallRow call={withThinking} index={1} />)
    expect(container.textContent).toContain('Thinking')
    expect(container.textContent).toContain('逐步推理过程')
  })

  it('无 thinking 时不渲染 Thinking 区块', () => {
    const { container } = render(<CallRow call={call} index={1} />)
    expect(container.textContent).not.toContain('Thinking')
  })

  it('finishReason 非空时展示', () => {
    const truncated: LLMCall = { ...call, id: 'c3', finishReason: 'length' }
    render(<CallRow call={truncated} index={1} />)
    expect(screen.getByTestId('call-row').textContent).toContain('length')
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

  it('展开后渲染段头与段内 call', async () => {
    ;(sessionAPI.llmDetails as Mock).mockResolvedValue([segment])
    renderWithClient(<LLMDetailsView sessionId="s1" />)
    fireEvent.click(screen.getByTestId('llm-details-toggle'))
    await waitFor(() => {
      expect(screen.getAllByTestId('segment-header')).toHaveLength(1)
      expect(screen.getAllByTestId('call-row')).toHaveLength(1)
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

  it('toggle 按钮反映总 call 数（跨段累加）', async () => {
    ;(sessionAPI.llmDetails as Mock).mockResolvedValue([segment, emptySegment])
    renderWithClient(<LLMDetailsView sessionId="s1" />)
    await waitFor(() => {
      // segment 有 1 call，emptySegment 有 0 call → 共 1
      expect(screen.getByTestId('llm-details-toggle').textContent).toContain('调用详情 (1)')
    })
  })

  it('段内多 call 按倒序渲染（最新在前）', async () => {
    const newer: LLMCall = { ...call, id: 'c-new', responseText: 'newer answer' }
    const seg: LLMSegment = { ...segment, id: 's-multi', calls: [call, newer] }
    ;(sessionAPI.llmDetails as Mock).mockResolvedValue([seg])
    renderWithClient(<LLMDetailsView sessionId="s1" />)
    fireEvent.click(screen.getByTestId('llm-details-toggle'))
    await waitFor(() => {
      const rows = screen.getAllByTestId('call-row')
      expect(rows).toHaveLength(2)
      // reverse()：newer 在前，序号 #2；call 在后，序号 #1
      expect(rows[0]?.textContent).toMatch(/^调用 #2/)
      expect(rows[1]?.textContent).toMatch(/^调用 #1/)
    })
  })
})
