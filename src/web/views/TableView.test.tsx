import type { LLMCall, LLMSegment } from '@shared/types/agent.js'
import type { Message } from '@shared/types/message.js'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimelineRow } from '../components/session/utils/timeline.js'
import { TableView } from './TableView.js'

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
