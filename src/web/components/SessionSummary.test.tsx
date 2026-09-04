/**
 * SessionSummary 组件测试。
 * 归并建议：本文件为新增「会话信息总结面板」组件的单元测试，与 LLMDetail.test.tsx
 * 同属「会话上下文展示」组件族；若后续合并展示组件，可并入对应测试文件。
 */
import type { LLMSegment } from '@shared/types/agent.js'
import type { Message, Session } from '@shared/types/message.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionSummary } from './SessionSummary.js'

vi.mock('../services/session.js', () => ({
  sessionAPI: {
    get: vi.fn(),
    messages: vi.fn(),
    llmDetails: vi.fn(),
  },
}))

const { sessionAPI } = await import('../services/session.js')

const session: Session = {
  id: 's1',
  title: '测试会话',
  parentId: null,
  projectId: null,
  branchPoint: null,
  metadata: {},
  agentType: null,
  worktreePath: null,
  source: null,
  deletedAt: null,
  createdAt: 1719300000000,
  updatedAt: 1719380000000,
}

const messages: Message[] = [
  {
    id: 'm1',
    sessionId: 's1',
    role: 'user',
    content: [{ _tag: 'text', text: 'hi' }],
    tokenCount: 5,
    createdAt: 1719300000000,
  },
  {
    id: 'm2',
    sessionId: 's1',
    role: 'assistant',
    content: [{ _tag: 'text', text: 'hello' }],
    tokenCount: 10,
    createdAt: 1719300000000,
  },
  {
    id: 'm3',
    sessionId: 's1',
    role: 'user',
    content: [{ _tag: 'text', text: 'again' }],
    tokenCount: 3,
    createdAt: 1719310000000,
  },
]

const segments: LLMSegment[] = [
  {
    id: 's1',
    fingerprint: 'fp',
    provider: 'zhipu',
    model: 'glm-5.2',
    systemPrompt: 'sys',
    tools: [],
    startedAt: 1,
    trigger: 'initial',
    contextWindow: 100000,
    calls: [
      {
        id: 'c1',
        timestamp: 1,
        usage: { input: 100, output: 50, cacheRead: 200 },
        latency: { firstToken: 10, total: 100 },
        cost: 0.02,
        responseText: '',
      },
      {
        id: 'c2',
        timestamp: 2,
        usage: { input: 300, output: 80, cacheRead: 500 },
        latency: { firstToken: 10, total: 100 },
        cost: 0.03,
        responseText: '',
      },
    ],
  },
]

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

function mockAll(
  s: Session | undefined = session,
  m: Message[] | undefined = messages,
  d: LLMSegment[] | undefined = segments,
) {
  ;(sessionAPI.get as Mock).mockResolvedValue(s)
  ;(sessionAPI.messages as Mock).mockResolvedValue(m)
  ;(sessionAPI.llmDetails as Mock).mockResolvedValue(d)
}

describe('SessionSummary', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('默认折叠，不渲染统计网格', () => {
    mockAll()
    renderWithClient(<SessionSummary sessionId="s1" />)
    expect(screen.queryByTestId('session-summary-grid')).toBeNull()
  })

  it('展开后渲染会话标题与聚合统计', async () => {
    mockAll()
    renderWithClient(<SessionSummary sessionId="s1" />)
    fireEvent.click(screen.getByTestId('session-summary-toggle'))
    await waitFor(() => {
      expect(screen.getByTestId('session-summary-grid').textContent).toContain('测试会话')
    })
    const text = screen.getByTestId('session-summary-grid').textContent ?? ''
    // 标题
    expect(text).toContain('测试会话')
    // 消息数 3
    expect(text).toMatch(/消息数\s*3/)
    // 聚合 token：input=400 output=130 cacheRead=700 total=1230
    expect(text).toContain('1,230')
    // 使用率：1230/100000 ≈ 1%
    expect(text).toContain('1%')
    // 上下文限制
    expect(text).toContain('100,000')
    // 成本 0.02+0.03=0.05
    expect(text).toContain('US$0.05')
    // 提供商/模型取自最后一次调用
    expect(text).toContain('zhipu')
    expect(text).toContain('glm-5.2')
  })

  it('用户/助手消息按 role 统计', async () => {
    mockAll()
    renderWithClient(<SessionSummary sessionId="s1" />)
    fireEvent.click(screen.getByTestId('session-summary-toggle'))
    await waitFor(() => {
      expect(screen.getByTestId('session-summary-grid').textContent).toContain('测试会话')
    })
    const text = screen.getByTestId('session-summary-grid').textContent ?? ''
    expect(text).toMatch(/用户消息\s*2/)
    expect(text).toMatch(/助手消息\s*1/)
  })

  it('缓存 token（读/写）展示读值与写 0', async () => {
    mockAll()
    renderWithClient(<SessionSummary sessionId="s1" />)
    fireEvent.click(screen.getByTestId('session-summary-toggle'))
    await waitFor(() => {
      expect(screen.getByTestId('session-summary-grid').textContent).toContain('测试会话')
    })
    const text = screen.getByTestId('session-summary-grid').textContent ?? ''
    // cacheRead=700，写为 0
    expect(text).toMatch(/缓存 token（读\/写）\s*700 \/ 0/)
  })

  it('无 LLM 调用时 token/上下文相关字段显示占位', async () => {
    mockAll(session, messages, [])
    renderWithClient(<SessionSummary sessionId="s1" />)
    fireEvent.click(screen.getByTestId('session-summary-toggle'))
    await waitFor(() => {
      const text = screen.getByTestId('session-summary-grid').textContent ?? ''
      expect(text).toContain('总 token')
      // 提供商/模型/上下文限制/使用率无数据时为 —
      expect(text).toContain('—')
    })
  })

  it('渲染创建时间与最后活动时间', async () => {
    mockAll()
    renderWithClient(<SessionSummary sessionId="s1" />)
    fireEvent.click(screen.getByTestId('session-summary-toggle'))
    await waitFor(() => {
      expect(screen.getByTestId('session-summary-grid').textContent).toContain('测试会话')
    })
    const text = screen.getByTestId('session-summary-grid').textContent ?? ''
    expect(text).toContain('创建时间')
    expect(text).toContain('最后活动')
    // 格式化后含「年」「月」字样
    expect(text).toMatch(/年/)
  })
})
