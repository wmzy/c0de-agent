import type { LLMCall, LLMSegment } from '@shared/types/agent.js'
import type { Message } from '@shared/types/message.js'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineRow } from './utils/timeline.js'

// mock MessageItem 为占位（含 latency 透传验证）
vi.mock('./MessageItem.js', () => ({
  MessageItem: ({ message, latency }: { message: Message; latency?: number }) => (
    <div data-testid={`pretty-msg-${message.id}`}>
      msg:{message.id}
      {latency != null ? `:${latency}ms` : ''}
    </div>
  ),
}))
// mock SegmentFooter / SegmentBreak 为占位
vi.mock('../LLMDetail.js', () => ({
  SegmentFooter: ({ segment }: { segment: { id: string } }) => (
    <div data-testid={`footer-${segment.id}`}>footer:{segment.id}</div>
  ),
  SegmentBreak: ({ segment }: { segment: { id: string; trigger: string } }) =>
    segment.trigger === 'initial' ? null : (
      <div data-testid={`break-${segment.id}`}>break:{segment.id}</div>
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

  it('segments 为空时退化为纯消息列表（无 footer/break）', () => {
    const rows: TimelineRow[] = [{ kind: 'message', message: mkMessage('m1', 'hi'), ts: 1 }]
    render(<TimelineChat rows={rows} showAllJson={false} />)
    expect(screen.getByTestId('pretty-msg-m1')).toBeTruthy()
    expect(screen.queryByTestId(/footer-/)).toBeNull()
    expect(screen.queryByTestId(/break-/)).toBeNull()
  })

  it('单段：渲染消息 + footer，无 break', () => {
    const rows: TimelineRow[] = [
      { kind: 'segment', segment: seg, ts: 1 },
      { kind: 'message', message: mkMessage('m1', 'hi'), ts: 100 },
    ]
    render(<TimelineChat rows={rows} showAllJson={false} />)
    expect(screen.getByTestId('pretty-msg-m1')).toBeTruthy()
    expect(screen.getByTestId('footer-seg')).toBeTruthy()
    expect(screen.queryByTestId(/break-/)).toBeNull()
  })

  it('call 行不被渲染', () => {
    const rows: TimelineRow[] = [
      { kind: 'segment', segment: seg, ts: 1 },
      { kind: 'call', call, segment: seg, ts: 50 },
      { kind: 'message', message: mkMessage('m1', 'hi'), ts: 100 },
    ]
    const { container } = render(<TimelineChat rows={rows} showAllJson={false} />)
    expect(container.textContent).not.toContain('调用 #')
  })

  it('多段：非首段 trigger≠initial 渲染 break', () => {
    const seg2: LLMSegment = { ...seg, id: 'seg2', trigger: 'model_change', startedAt: 200 }
    const rows: TimelineRow[] = [
      { kind: 'segment', segment: seg, ts: 1 },
      { kind: 'message', message: mkMessage('m1', 'a'), ts: 100 },
      { kind: 'segment', segment: seg2, ts: 200 },
      { kind: 'message', message: mkMessage('m2', 'b'), ts: 300 },
    ]
    render(<TimelineChat rows={rows} showAllJson={false} />)
    expect(screen.getByTestId('break-seg2')).toBeTruthy()
    expect(screen.getByTestId('footer-seg')).toBeTruthy()
    expect(screen.getByTestId('footer-seg2')).toBeTruthy()
  })

  it('latency 透传到 MessageItem', () => {
    const rows: TimelineRow[] = [
      { kind: 'segment', segment: seg, ts: 1 },
      { kind: 'message', message: mkMessage('m1', 'hi'), ts: 100, latency: 1500 },
    ]
    render(<TimelineChat rows={rows} showAllJson={false} />)
    expect(screen.getByTestId('pretty-msg-m1').textContent).toContain('1500ms')
  })

  it('空壳消息默认隐藏', () => {
    const rows: TimelineRow[] = [{ kind: 'message', message: mkMessage('e', null), ts: 1 }]
    render(<TimelineChat rows={rows} showAllJson={false} />)
    expect(screen.queryByTestId('pretty-msg-e')).toBeNull()
  })
})
