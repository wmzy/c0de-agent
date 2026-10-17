import type { LLMCall, LLMSegment } from '@shared/types/agent.js'
import type { Message } from '@shared/types/message.js'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimelineRow } from '@/components/session/utils/timeline.js'
import { TableView } from '@/views/TableView.js'

function mkMessage(id: string, role: Message['role'], text: string, createdAt = 1): Message {
  return {
    id,
    sessionId: 's',
    role,
    content: [{ _tag: 'text' as const, text }],
    tokenCount: 0,
    createdAt,
  }
}

/** 一条 assistant 消息内并行发起多个工具调用（每个 tool_call 都是独立 part）。 */
function mkToolMessage(id: string, tools: string[], ts = 1): TimelineRow {
  return {
    kind: 'message',
    ts,
    message: {
      id,
      sessionId: 's',
      role: 'assistant',
      content: tools.map((tool, i) => ({
        _tag: 'tool_call' as const,
        id: `${id}-t${i}`,
        tool,
        input: {},
      })),
      tokenCount: 0,
      createdAt: 1,
    },
  }
}

const seg: LLMSegment = {
  id: 'seg',
  fingerprint: 'fp',
  provider: 'p',
  model: 'gpt-4',
  systemPrompt: 'sys',
  tools: [],
  startedAt: 1,
  trigger: 'initial',
  calls: [],
}
const call: LLMCall = {
  id: 'c',
  timestamp: 1,
  usage: { input: 10, output: 5 },
  latency: { firstToken: 1, total: 1 },
  cost: 0.01,
  responseText: '调用回复',
}

describe('TableView', () => {
  afterEach(() => cleanup())

  it('渲染所有行', () => {
    const rows: TimelineRow[] = [
      { kind: 'message', message: mkMessage('u1', 'user', '你好'), ts: 1 },
      { kind: 'segment', segment: seg, ts: 2 },
      { kind: 'call', call, segment: seg, ts: 3 },
    ]
    render(<TableView rows={rows} />)
    expect(screen.getAllByTestId('table-row')).toHaveLength(3)
  })

  it('文本搜索筛选匹配项', () => {
    const rows: TimelineRow[] = [
      { kind: 'message', message: mkMessage('u1', 'user', 'hello world'), ts: 1 },
      { kind: 'message', message: mkMessage('u2', 'assistant', 'foo bar'), ts: 2 },
    ]
    render(<TableView rows={rows} />)
    fireEvent.change(screen.getByTestId('table-search'), { target: { value: 'hello' } })
    expect(screen.getAllByTestId('table-row')).toHaveLength(1)
  })

  it('类型筛选只显示调用行', () => {
    const rows: TimelineRow[] = [
      { kind: 'message', message: mkMessage('u1', 'user', 'x'), ts: 1 },
      { kind: 'call', call, segment: seg, ts: 2 },
      { kind: 'segment', segment: seg, ts: 3 },
    ]
    render(<TableView rows={rows} />)
    fireEvent.change(screen.getByTestId('table-filter-type'), { target: { value: 'call' } })
    expect(screen.getAllByTestId('table-row')).toHaveLength(1)
  })

  it('角色筛选只显示 user', () => {
    const rows: TimelineRow[] = [
      { kind: 'message', message: mkMessage('u1', 'user', 'x'), ts: 1 },
      { kind: 'message', message: mkMessage('a1', 'assistant', 'y'), ts: 2 },
    ]
    render(<TableView rows={rows} />)
    fireEvent.change(screen.getByTestId('table-filter-role'), { target: { value: 'user' } })
    expect(screen.getAllByTestId('table-row')).toHaveLength(1)
  })

  it('点击行展开原始 JSON', () => {
    const rows: TimelineRow[] = [{ kind: 'message', message: mkMessage('u1', 'user', 'x'), ts: 1 }]
    render(<TableView rows={rows} />)
    expect(screen.queryByTestId('table-row-json')).toBeNull()
    fireEvent.click(screen.getByTestId('table-row'))
    expect(screen.getByTestId('table-row-json')).toBeTruthy()
  })

  it('无匹配显示空态', () => {
    const rows: TimelineRow[] = [{ kind: 'message', message: mkMessage('u1', 'user', 'x'), ts: 1 }]
    render(<TableView rows={rows} />)
    fireEvent.change(screen.getByTestId('table-search'), { target: { value: 'zzz' } })
    expect(screen.queryByTestId('table-row')).toBeNull()
    expect(screen.getByText('无匹配项')).toBeTruthy()
  })
})

/**
 * 表格视图的行此前只挂在裸 <tr onClick> 上：没有 tabIndex、没有键盘处理。
 * 键盘用户 Tab 走遍筛选条与计数后直接跳出表格（实测表格视图内 Tab 序列：
 * 筛选控件 → 计数 → Todo 面板，tbody 行一个都碰不到），「查看原始 JSON」
 * 这条排障入口对键盘与读屏用户等于不存在。
 */
describe('TableView 行的键盘可达性', () => {
  afterEach(() => cleanup())

  const rows: TimelineRow[] = [
    { kind: 'message', message: mkMessage('u1', 'user', '第一行'), ts: 1 },
    { kind: 'message', message: mkMessage('a1', 'assistant', '第二行'), ts: 2 },
  ]

  /** 首行：每个用例都要一个稳定的展开目标。 */
  const firstRow = (): HTMLElement => screen.getAllByTestId('table-row')[0] as HTMLElement

  it('每一行都进入 Tab 序列（tabIndex=0）', () => {
    render(<TableView rows={rows} />)
    const rowEls = screen.getAllByTestId('table-row')
    expect(rowEls).toHaveLength(2)
    for (const el of rowEls) {
      expect(el.getAttribute('tabindex')).toBe('0')
    }
  })

  it('Enter 展开原始 JSON，与点击同效', () => {
    render(<TableView rows={rows} />)
    expect(screen.queryByTestId('table-row-json')).toBeNull()

    fireEvent.keyDown(firstRow(), { key: 'Enter' })

    expect(screen.getByTestId('table-row-json')).toBeTruthy()
  })

  it('Space 也能展开，且不会顺带滚动页面', () => {
    render(<TableView rows={rows} />)
    const row = firstRow()
    // 空格默认滚动；行内它是唯一动作，必须被 preventDefault 拦下
    const handled = fireEvent.keyDown(row, { key: ' ' })
    expect(handled).toBe(false)
    expect(screen.getByTestId('table-row-json')).toBeTruthy()
  })

  it('aria-expanded 跟随展开状态（读屏能知道当前行是不是开着）', () => {
    render(<TableView rows={rows} />)
    const row = firstRow()
    expect(row.getAttribute('aria-expanded')).toBe('false')

    fireEvent.keyDown(row, { key: 'Enter' })
    expect(row.getAttribute('aria-expanded')).toBe('true')

    // 再按一次收起
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('行的可访问名来自单元格文本，不被 aria-label 截断', () => {
    render(<TableView rows={rows} />)
    // 若加了 aria-label，「摘要」列内容对读屏就不可见了——第一行摘要必须可达
    const row = firstRow()
    expect(row.textContent).toContain('第一行')
    expect(row.getAttribute('aria-label')).toBeNull()
  })

  it('非 Enter/Space 的按键不误触发展开', () => {
    render(<TableView rows={rows} />)
    const row = firstRow()
    fireEvent.keyDown(row, { key: 'ArrowDown' })
    expect(screen.queryByTestId('table-row-json')).toBeNull()
  })
})

/**
 * 一条 assistant 消息可以并行发起多个工具调用（每个 tool_call 都是独立 part）。
 * 此前整张表只认每条消息的首个工具：列里看不到第二个工具、筛选下拉里没有它、
 * 文本搜索也搜不到 —— 选中它得到「无匹配项」，用户据此认定该工具从没跑过。
 */
describe('TableView 一条消息内的多个工具调用', () => {
  afterEach(() => cleanup())

  const parallelRow = mkToolMessage('a1', ['read', 'grep', 'bash'])

  it('工具筛选下拉列出并行调用的全部工具名', () => {
    render(<TableView rows={[parallelRow]} />)
    const options = Array.from(screen.getByLabelText('工具筛选').querySelectorAll('option')).map(
      (o) => o.getAttribute('value'),
    )
    expect(options).toEqual(['all', 'bash', 'grep', 'read'])
  })

  it('按非首个工具名筛选仍能命中该行', () => {
    render(<TableView rows={[parallelRow]} />)
    fireEvent.change(screen.getByLabelText('工具筛选'), { target: { value: 'bash' } })
    expect(screen.getAllByTestId('table-row')).toHaveLength(1)
  })

  it('文本搜索命中非首个工具名', () => {
    render(<TableView rows={[parallelRow]} />)
    fireEvent.change(screen.getByTestId('table-search'), { target: { value: 'grep' } })
    expect(screen.getAllByTestId('table-row')).toHaveLength(1)
  })

  it('「角色/工具」列列出全部工具名', () => {
    render(<TableView rows={[parallelRow]} />)
    const cell = screen.getAllByTestId('table-row')[0]?.querySelectorAll('td')[2]
    expect(cell?.textContent).toBe('read grep bash')
  })
})

/**
 * 搜索索引不能复用展示用的截断摘要。
 *
 * 缺陷：rowSearchText 直接用 rowSummary，而 rowSummary 只取首个 text part 的
 * 前 120 字符。搜索框自报「搜索当前会话的消息与调用」，实际只索引这 120 字
 * 与工具名：长回复后半段、第二个及以后的 text part、thinking / steering、
 * 工具入参（命令 / 路径 / pattern）全部搜不到。用户据此得出相反结论
 * 「agent 从没提过 X / 从没跑过这个命令」，与 8086032 修的「工具筛选只认
 * 第一个」同族。
 */
describe('TableView 搜索索引覆盖整行内容', () => {
  afterEach(() => cleanup())

  const filler = 'x'.repeat(200)
  const longReplyRow: TimelineRow = {
    kind: 'message',
    ts: 1,
    message: {
      id: 'm-long',
      sessionId: 's',
      role: 'assistant',
      content: [{ _tag: 'text', text: `${filler} 关键结论是缓存失效重放` }],
      tokenCount: 0,
      createdAt: 1,
    },
  }

  it('命中第 120 字符之后的正文（摘要列仍是截断的）', () => {
    render(<TableView rows={[longReplyRow]} />)
    fireEvent.change(screen.getByTestId('table-search'), { target: { value: '缓存失效重放' } })
    expect(screen.getAllByTestId('table-row')).toHaveLength(1)
    // 展示摘要仍按 120 字符截断，不因索引变全而变宽（摘要列是最后一个 td）
    const cell = screen.getAllByTestId('table-row')[0]?.querySelectorAll('td')[7]
    expect(cell?.textContent?.length).toBe(120)
  })

  it('命中第二个及以后的 text part 与 thinking 文本', () => {
    const row: TimelineRow = {
      kind: 'message',
      ts: 1,
      message: {
        id: 'm-multi',
        sessionId: 's',
        role: 'assistant',
        content: [
          { _tag: 'text', text: '先说一句无关的话' },
          { _tag: 'text', text: '第二段里有 migration_0042 这个词' },
          { _tag: 'thinking', text: '心里在想 rollback_plan' },
        ],
        tokenCount: 0,
        createdAt: 1,
      },
    }
    render(<TableView rows={[row]} />)
    for (const needle of ['migration_0042', 'rollback_plan']) {
      fireEvent.change(screen.getByTestId('table-search'), { target: { value: needle } })
      expect(screen.getAllByTestId('table-row')).toHaveLength(1)
    }
  })

  it('命中工具入参里的命令与路径', () => {
    const row: TimelineRow = {
      kind: 'message',
      ts: 1,
      message: {
        id: 'm-tool',
        sessionId: 's',
        role: 'assistant',
        content: [
          {
            _tag: 'tool_call',
            id: 'c1',
            tool: 'bash',
            input: { command: 'grep -rn zeta-marker src/server' },
          },
        ],
        tokenCount: 0,
        createdAt: 1,
      },
    }
    render(<TableView rows={[row]} />)
    fireEvent.change(screen.getByTestId('table-search'), { target: { value: 'zeta-marker' } })
    expect(screen.getAllByTestId('table-row')).toHaveLength(1)
  })

  it('调用行可搜到 responseText 后半段（摘要列仍截断）', () => {
    const row: TimelineRow = {
      kind: 'call',
      ts: 1,
      segment: seg,
      call: { ...call, responseText: `${filler} 回复尾部写着 delta_8891` },
    }
    render(<TableView rows={[row]} />)
    fireEvent.change(screen.getByTestId('table-search'), { target: { value: 'delta_8891' } })
    expect(screen.getAllByTestId('table-row')).toHaveLength(1)
  })

  it('搜不到时仍是无匹配项（索引扩大不放宽到全命中）', () => {
    render(<TableView rows={[longReplyRow]} />)
    fireEvent.change(screen.getByTestId('table-search'), { target: { value: '绝不存在的词' } })
    expect(screen.queryAllByTestId('table-row')).toHaveLength(0)
  })
})

/**
 * 表格视图的筛选态必须随会话复位。
 *
 * TableView 挂在 Chat 里，而 Chat 被 @native-router 按 path 复用：切到**消息已被
 * react-query 缓存**的会话时不走 ChatSkeleton 早返回，Chat（以及它里面的 TableView）
 * 不重建 —— 上一条会话的搜索词、三个筛选、展开行整块留到新会话。
 *   - 搜索词让新时间线一进来就是「3/812」；
 *   - 工具筛选指向新会话不存在的工具 → 0/812 +「无匹配项」，用户据此认为这份
 *     时间线是空的（与「画不出来≠没有了」同族）；
 *   - 展开行记的是**上一条会话 rows 的下标**，在新 rows 上命中的是另一行，
 *     凭空展开一条无关消息的原始 JSON。
 */
describe('TableView 视图态随会话复位', () => {
  afterEach(() => cleanup())

  // A：一行 assistant，带 bash 调用（让工具筛选里出现 bash）
  const rowsA: TimelineRow[] = [mkToolMessage('a1', ['bash'])]
  // B：两条纯文本消息，既没有 bash、也不含 A 的搜索词
  const rowsB: TimelineRow[] = [
    { kind: 'message', message: mkMessage('u1', 'user', '乙会话的第一条'), ts: 1 },
    { kind: 'message', message: mkMessage('u2', 'assistant', '乙会话的回复'), ts: 2 },
  ]

  it('切会话后搜索词与展开行都不再沿用', () => {
    const view = render(<TableView rows={rowsA} sessionId="s1" />)
    // 用能命中 A 的词（A 只有一行、工具名 bash 进索引），避免「筛空后没有行可展开」
    fireEvent.change(screen.getByTestId('table-search'), { target: { value: 'bash' } })
    fireEvent.click(screen.getAllByTestId('table-row')[0] as HTMLElement)
    expect(screen.getByTestId('table-row-json')).toBeTruthy()

    view.rerender(<TableView rows={rowsB} sessionId="s2" />)

    // 搜索框归位：新会话的时间线不再被上一条会话的词过滤
    expect(screen.getByTestId('table-search')).toHaveProperty('value', '')
    expect(screen.getAllByTestId('table-row')).toHaveLength(2)
    // 展开行归位：既不能空着（索引越界）也不能展开到另一行上
    expect(screen.queryByTestId('table-row-json')).toBeNull()
  })

  it('切到没有该工具的会话时不再整表「无匹配项」', () => {
    const view = render(<TableView rows={rowsA} sessionId="s1" />)
    fireEvent.change(screen.getByTestId('table-filter-tool'), { target: { value: 'bash' } })
    expect(screen.getAllByTestId('table-row')).toHaveLength(1)

    view.rerender(<TableView rows={rowsB} sessionId="s2" />)

    expect(screen.getAllByTestId('table-row')).toHaveLength(2)
    expect(screen.queryByText('无匹配项')).toBeNull()
  })

  it('同一会话内重新渲染不复位（复位只认会话切换）', () => {
    const view = render(<TableView rows={rowsA} sessionId="s1" />)
    fireEvent.change(screen.getByTestId('table-search'), { target: { value: '乙' } })

    view.rerender(<TableView rows={rowsB} sessionId="s1" />)

    expect(screen.getByTestId('table-search')).toHaveProperty('value', '乙')
  })
})
