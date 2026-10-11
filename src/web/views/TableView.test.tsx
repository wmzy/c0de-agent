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
