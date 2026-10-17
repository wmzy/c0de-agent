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
import { SessionSummary } from '@/components/SessionSummary.js'

vi.mock('@/services/session.js', () => ({
  sessionAPI: {
    get: vi.fn(),
    messages: vi.fn(),
    llmDetails: vi.fn(),
  },
}))

const { sessionAPI } = await import('@/services/session.js')

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

  // FP 舍入回归：1.005 直接 toFixed 会显示 US$1.00（少一分钱），roundTo 后为 US$1.01。
  it('成本按十进制舍入展示', async () => {
    const base = segments[0]
    const call = base?.calls[0]
    if (!base || !call) throw new Error('fixture missing')
    const fpSegments: LLMSegment[] = [{ ...base, calls: [{ ...call, cost: 1.005 }] }]
    mockAll(session, messages, fpSegments)
    renderWithClient(<SessionSummary sessionId="s1" />)
    fireEvent.click(screen.getByTestId('session-summary-toggle'))
    await waitFor(() => {
      expect(screen.getByTestId('session-summary-grid').textContent).toContain('US$1.01')
    })
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

/**
 * 拉不到 ≠ 0。
 *
 * 缺陷：面板只解构 llm-details 的 data。请求 500 时 segments 为 undefined，
 * computeStats 拿 [] 累加，照常渲染一整套精确的 0 与 US$0.00（实测注入 500，
 * 「总 token 0 / 总成本（估算）US$0.00」原样出现）。用户据此认为这个会话
 * 真的一次调用都没发生、花了 0 美元——比报错更糟的是它看起来完全可信。
 * 消息数与时间戳来自另两个查询，不受影响。
 */
describe('SessionSummary 调用明细读失败态', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  async function openWithFailedLlm() {
    ;(sessionAPI.get as Mock).mockResolvedValue(session)
    ;(sessionAPI.messages as Mock).mockResolvedValue(messages)
    ;(sessionAPI.llmDetails as Mock).mockRejectedValue(new Error('llm details 后端炸了'))
    renderWithClient(<SessionSummary sessionId="s1" />)
    fireEvent.click(screen.getByTestId('session-summary-toggle'))
    const err = await screen.findByTestId('summary-llm-error')
    await waitFor(() => {
      expect(screen.getByTestId('session-summary-grid').textContent).toContain('测试会话')
    })
    return err
  }

  it('显示失败原因并说明这些数字不可信', async () => {
    const err = await openWithFailedLlm()
    expect(err).toHaveAttribute('role', 'alert')
    expect(err.textContent).toContain('llm details 后端炸了')
  })

  it('不把读不到渲染成 0 token / US$0.00', async () => {
    await openWithFailedLlm()
    const text = screen.getByTestId('session-summary-grid').textContent ?? ''
    // 这些字段全部由 segments 推导，读不到时必须是「读不到」而非 0
    expect(text).toMatch(/总 token\s*读不到/)
    expect(text).toMatch(/总成本（估算）\s*读不到/)
    expect(text).toMatch(/输入 token\s*读不到/)
    expect(text).toMatch(/模型\s*读不到/)
    expect(text).not.toMatch(/总 token\s*0/)
    expect(text).not.toContain('US$0.00')
  })

  it('来自其它查询的消息数与时间戳照常显示真实值', async () => {
    await openWithFailedLlm()
    const text = screen.getByTestId('session-summary-grid').textContent ?? ''
    expect(text).toMatch(/消息数\s*3/)
    expect(text).toMatch(/用户消息\s*2/)
    expect(text).toMatch(/助手消息\s*1/)
    expect(text).toMatch(/创建时间\s*\d{4}年/)
  })

  it('读失败时不显示「未估价调用」计数（那是从空数组算出的 0）', async () => {
    await openWithFailedLlm()
    expect(screen.getByTestId('session-summary-grid').textContent ?? '').not.toContain('未估价调用')
  })
})

/**
 * 另两条查询（messages / session）的「拉不到 ≠ 0」。
 *
 * 缺陷：面板只对 llm-details 解构了 isError，另两条读了 data 就算完。
 * 首载失败时 messages 为 undefined，computeStats 拿 [] 算出 messageCount /
 * userMessages / assistantMessages 三个精确的 0；session 为 undefined 时标题
 * 退化成「（未命名会话）」、创建时间/最后活动退化成「—」。用户打开「会话信息」
 * 想确认这轮对话还在不在，看到的却是「0 条消息、没有名字」，据此认定内容已丢失。
 */
describe('SessionSummary 消息/会话元信息读失败态', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('消息列表读失败：三条消息计数都是「读不到」并给出原因，不显示 0', async () => {
    ;(sessionAPI.get as Mock).mockResolvedValue(session)
    ;(sessionAPI.messages as Mock).mockRejectedValue(new Error('messages 后端炸了'))
    ;(sessionAPI.llmDetails as Mock).mockResolvedValue(segments)
    renderWithClient(<SessionSummary sessionId="s1" />)
    fireEvent.click(screen.getByTestId('session-summary-toggle'))

    const err = await screen.findByTestId('summary-messages-error')
    expect(err).toHaveAttribute('role', 'alert')
    expect(err.textContent).toContain('messages 后端炸了')

    await waitFor(() => {
      expect(screen.getByTestId('session-summary-grid').textContent).toContain('测试会话')
    })
    const text = screen.getByTestId('session-summary-grid').textContent ?? ''
    expect(text).toMatch(/消息数\s*读不到/)
    expect(text).toMatch(/用户消息\s*读不到/)
    expect(text).toMatch(/助手消息\s*读不到/)
    // 调用明细这次读到了，照常显示真实值
    expect(text).toMatch(/总 token\s*1,230/)
  })

  it('会话元信息读失败：标题是「读不到」而不是「（未命名会话）」，时间同理', async () => {
    ;(sessionAPI.get as Mock).mockRejectedValue(new Error('session 后端炸了'))
    ;(sessionAPI.messages as Mock).mockResolvedValue(messages)
    ;(sessionAPI.llmDetails as Mock).mockResolvedValue(segments)
    renderWithClient(<SessionSummary sessionId="s1" />)
    fireEvent.click(screen.getByTestId('session-summary-toggle'))

    const err = await screen.findByTestId('summary-session-error')
    expect(err).toHaveAttribute('role', 'alert')
    expect(err.textContent).toContain('session 后端炸了')

    const text = await waitFor(() => {
      const t = screen.getByTestId('session-summary-grid').textContent ?? ''
      expect(t).toContain('会话元信息读取失败')
      return t
    })
    expect(text).not.toContain('（未命名会话）')
    expect(text).toMatch(/创建时间\s*读不到/)
    expect(text).toMatch(/最后活动\s*读不到/)
    // 消息列表这次读到了，计数照常
    expect(text).toMatch(/消息数\s*3/)
  })

  it('任一查询尚未落地都显示「加载中…」——不把还没到的数据渲染成 0', async () => {
    ;(sessionAPI.get as Mock).mockResolvedValue(session)
    // messages 永不 resolve（模拟慢查询）
    ;(sessionAPI.messages as Mock).mockImplementation(() => new Promise(() => {}))
    ;(sessionAPI.llmDetails as Mock).mockResolvedValue(segments)
    // 自建 QueryClient：靠查询状态确认「另两条已落地」，而不是靠首次渲染的
    // 短暂「加载中…」——否则本用例在旧实现下也会通过（那时初帧同样是加载中）。
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <SessionSummary sessionId="s1" />
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByTestId('session-summary-toggle'))

    await waitFor(() => {
      expect(qc.getQueryState(['session', 's1', 'llm-details'])?.status).toBe('success')
      expect(qc.getQueryState(['session', 's1'])?.status).toBe('success')
    })
    const text = screen.getByTestId('session-summary-grid').textContent ?? ''
    expect(text).toContain('加载中…')
    expect(text).not.toContain('消息数')
  })
})
