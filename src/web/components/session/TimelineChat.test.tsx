import type { LLMCall, LLMSegment } from '@shared/types/agent.js'
import type { Message } from '@shared/types/message.js'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineRow } from './utils/timeline.js'

// 聚焦行级控制逻辑：美化渲染由各组件自身测试覆盖，这里 mock 成占位。
vi.mock('./MessageItem.js', () => ({
  MessageItem: ({ message }: { message: Message }) => (
    <div data-testid={`pretty-msg-${message.id}`}>msg:{message.id}</div>
  ),
}))
vi.mock('../LLMDetail.js', () => ({
  CallRow: ({ call }: { call: { id: string } }) => (
    <div data-testid={`pretty-call-${call.id}`}>call:{call.id}</div>
  ),
  SegmentHeader: ({ segment }: { segment: { id: string } }) => (
    <div data-testid={`pretty-seg-${segment.id}`}>seg:{segment.id}</div>
  ),
}))

const { TimelineChat } = await import('./TimelineChat.js')

function mkMessage(id: string, text: string | null, createdAt = 1): Message {
  return {
    id,
    sessionId: 's',
    role: 'assistant',
    content: text === null ? [] : [{ _tag: 'text' as const, text }],
    tokenCount: 0,
    createdAt,
  }
}

const seg: LLMSegment = {
  id: 'seg',
  fingerprint: 'fp',
  provider: 'p',
  model: 'm',
  systemPrompt: 'sys',
  tools: [],
  startedAt: 1,
  trigger: 'initial',
  calls: [],
}
const call: LLMCall = {
  id: 'c',
  timestamp: 1,
  usage: { input: 1, output: 1 },
  latency: { firstToken: 1, total: 1 },
  cost: 0,
  responseText: 'r',
}

describe('TimelineChat', () => {
  afterEach(() => cleanup())

  it('美化态渲染 message/call/segment 行', () => {
    const rows: TimelineRow[] = [
      { kind: 'message', message: mkMessage('m1', 'hi'), ts: 1 },
      { kind: 'call', call, segment: seg, ts: 1 },
      { kind: 'segment', segment: seg, ts: 1 },
    ]
    render(<TimelineChat rows={rows} showAllJson={false} />)
    expect(screen.getByTestId('pretty-msg-m1')).toBeTruthy()
    expect(screen.getByTestId('pretty-call-c')).toBeTruthy()
    expect(screen.getByTestId('pretty-seg-seg')).toBeTruthy()
  })

  it('空壳消息默认隐藏', () => {
    const rows: TimelineRow[] = [{ kind: 'message', message: mkMessage('e', null), ts: 1 }]
    render(<TimelineChat rows={rows} showAllJson={false} />)
    expect(screen.queryByTestId('pretty-msg-e')).toBeNull()
  })

  it('showAllJson 露出空壳消息并显示 JSON', () => {
    const rows: TimelineRow[] = [{ kind: 'message', message: mkMessage('e', null), ts: 1 }]
    const { container } = render(<TimelineChat rows={rows} showAllJson={true} />)
    expect(screen.queryByTestId('pretty-msg-e')).toBeNull()
    expect(container.textContent).toContain('"role"')
  })

  it('showAllJson 全局切换所有行为 JSON', () => {
    const rows: TimelineRow[] = [{ kind: 'message', message: mkMessage('m1', 'hi'), ts: 1 }]
    const { container } = render(<TimelineChat rows={rows} showAllJson={true} />)
    expect(screen.queryByTestId('pretty-msg-m1')).toBeNull()
    expect(container.textContent).toContain('"role"')
  })

  it('局部 { } toggle 切换单行 JSON（不影响其它行）', () => {
    const rows: TimelineRow[] = [
      { kind: 'message', message: mkMessage('m1', 'a'), ts: 1 },
      { kind: 'message', message: mkMessage('m2', 'b'), ts: 2 },
    ]
    render(<TimelineChat rows={rows} showAllJson={false} />)
    expect(screen.getByTestId('pretty-msg-m1')).toBeTruthy()
    expect(screen.getByTestId('pretty-msg-m2')).toBeTruthy()
    fireEvent.click(screen.getByTestId('row-json-m:m1'))
    expect(screen.queryByTestId('pretty-msg-m1')).toBeNull()
    expect(screen.getByTestId('pretty-msg-m2')).toBeTruthy()
    fireEvent.click(screen.getByTestId('row-json-m:m1'))
    expect(screen.getByTestId('pretty-msg-m1')).toBeTruthy()
  })
})
