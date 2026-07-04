import type { LLMCall, LLMSegment } from '@shared/types/agent.js'
import type { Message } from '@shared/types/message.js'
import { describe, expect, it } from 'vitest'
import {
  buildTimeline,
  groupBySegment,
  isEmptyMessage,
  type TimelineRow,
  userMessageText,
} from './timeline.js'

function msg(id: string, createdAt: number, content: Message['content'] = []): Message {
  return { id, sessionId: 's', role: 'assistant', content, tokenCount: 0, createdAt }
}

const baseCall: LLMCall = {
  id: 'c0',
  timestamp: 1,
  usage: { input: 10, output: 5 },
  latency: { firstToken: 100, total: 1500 },
  cost: 0.001,
  responseText: 'r',
}

function seg(overrides: Partial<LLMSegment> = {}): LLMSegment {
  return {
    id: 'seg0',
    fingerprint: 'fp',
    provider: 'p',
    model: 'm',
    systemPrompt: 'sys',
    tools: [],
    startedAt: 1,
    trigger: 'initial',
    calls: [baseCall],
    ...overrides,
  }
}

function kinds(rows: TimelineRow[]): string[] {
  return rows.map((r) => r.kind)
}

describe('buildTimeline', () => {
  it('空输入返回空数组', () => {
    expect(buildTimeline([], [])).toEqual([])
  })

  it('仅消息：按 createdAt 升序', () => {
    const rows = buildTimeline([msg('a', 30), msg('b', 10), msg('c', 20)], [])
    expect(rows.map((r) => r.kind)).toEqual(['message', 'message', 'message'])
    expect(rows.map((r) => (r.kind === 'message' ? r.message.id : ''))).toEqual(['b', 'c', 'a'])
  })

  it('仅段：段头排在自身 calls 之前', () => {
    const rows = buildTimeline([], [seg({ startedAt: 1, calls: [{ ...baseCall, timestamp: 1 }] })])
    expect(kinds(rows)).toEqual(['segment', 'call'])
  })

  it('段头/call/message 同时间戳：稳定排序 segment<call<message', () => {
    const rows = buildTimeline(
      [msg('m', 100)],
      [seg({ startedAt: 100, calls: [{ ...baseCall, timestamp: 100 }] })],
    )
    expect(kinds(rows)).toEqual(['segment', 'call', 'message'])
  })

  it('混合：失败调用（无对应消息）作为孤立 call 行保留', () => {
    // call@50 无 assistant 消息（模拟 hadError 只记 call）；call@100 配 message@100
    const rows = buildTimeline(
      [msg('m', 100)],
      [
        seg({
          startedAt: 50,
          calls: [{ ...baseCall, id: 'fail', timestamp: 50 }],
        }),
        seg({ id: 'seg2', startedAt: 100, calls: [{ ...baseCall, timestamp: 100 }] }),
      ],
    )
    expect(kinds(rows)).toEqual(['segment', 'call', 'segment', 'call', 'message'])
  })

  it('时间交错：早 call 排在晚 message 之前', () => {
    const rows = buildTimeline(
      [msg('m', 200)],
      [seg({ startedAt: 100, calls: [{ ...baseCall, timestamp: 100 }] })],
    )
    expect(kinds(rows)).toEqual(['segment', 'call', 'message'])
  })
})

describe('isEmptyMessage', () => {
  it('无 content 视为空壳', () => {
    expect(isEmptyMessage(msg('e', 1, []))).toBe(true)
  })

  it('有 content 非空壳', () => {
    expect(isEmptyMessage(msg('e', 1, [{ _tag: 'text', text: 'x' }]))).toBe(false)
  })
})

describe('buildTimeline latency 配对', () => {
  it('assistant 消息配对最近的 call latency', () => {
    const rows = buildTimeline(
      [msg('m', 100, [{ _tag: 'text', text: 'hi' }])],
      [seg({ startedAt: 50, calls: [{ ...baseCall, id: 'c1', timestamp: 50 }] })],
    )
    const msgRow = rows.find((r) => r.kind === 'message')
    expect(msgRow).toBeDefined()
    expect(msgRow?.kind).toBe('message')
    if (msgRow?.kind === 'message') expect(msgRow.latency).toBe(1500)
  })

  it('user 消息不配对 latency', () => {
    const userMsg: Message = {
      id: 'u',
      sessionId: 's',
      role: 'user',
      content: [{ _tag: 'text', text: 'hi' }],
      tokenCount: 0,
      createdAt: 100,
    }
    const rows = buildTimeline(
      [userMsg],
      [seg({ startedAt: 50, calls: [{ ...baseCall, id: 'c1', timestamp: 50 }] })],
    )
    const msgRow = rows.find((r) => r.kind === 'message')
    if (msgRow?.kind === 'message') expect(msgRow.latency).toBeUndefined()
  })

  it('latency 不跨段配对：msg 属 seg2 配对 seg2 的 call', () => {
    const rows = buildTimeline(
      [msg('m', 200, [{ _tag: 'text', text: 'hi' }])],
      [
        seg({ id: 'seg1', startedAt: 50, calls: [{ ...baseCall, id: 'c1', timestamp: 50 }] }),
        seg({
          id: 'seg2',
          startedAt: 150,
          calls: [
            { ...baseCall, id: 'c2', timestamp: 150, latency: { firstToken: 10, total: 800 } },
          ],
        }),
      ],
    )
    const msgRow = rows.find((r) => r.kind === 'message')
    if (msgRow?.kind === 'message') expect(msgRow.latency).toBe(800)
  })

  it('孤儿 call 不影响配对，仍保留为 call 行', () => {
    const rows = buildTimeline(
      [msg('m', 200, [{ _tag: 'text', text: 'hi' }])],
      [
        seg({
          startedAt: 1,
          calls: [
            { ...baseCall, id: 'fail', timestamp: 50 },
            { ...baseCall, id: 'ok', timestamp: 100 },
          ],
        }),
      ],
    )
    const callIds = rows
      .filter((r) => r.kind === 'call')
      .map((r) => (r.kind === 'call' ? r.call.id : ''))
    expect(callIds).toContain('fail')
    expect(callIds).toContain('ok')
    const msgRow = rows.find((r) => r.kind === 'message')
    if (msgRow?.kind === 'message') expect(msgRow.latency).toBe(1500)
  })
})

describe('groupBySegment', () => {
  it('segments 为空：所有消息归入单个隐式组', () => {
    const rows = buildTimeline([msg('m', 100, [{ _tag: 'text', text: 'x' }])], [])
    const groups = groupBySegment(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.messages).toHaveLength(1)
    expect(groups[0]?.isFirst).toBe(true)
  })

  it('单段：message 行保留，call 行被滤掉', () => {
    const rows = buildTimeline(
      [msg('m', 100, [{ _tag: 'text', text: 'x' }])],
      [seg({ calls: [{ ...baseCall, id: 'c1', timestamp: 50 }] })],
    )
    const groups = groupBySegment(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.messages.map((m) => m.message.id)).toEqual(['m'])
  })

  it('多段：按 segment 行切分', () => {
    const rows = buildTimeline(
      [
        msg('m1', 100, [{ _tag: 'text', text: 'a' }]),
        msg('m2', 300, [{ _tag: 'text', text: 'b' }]),
      ],
      [
        seg({ id: 'seg1', startedAt: 50, calls: [{ ...baseCall, id: 'c1', timestamp: 50 }] }),
        seg({
          id: 'seg2',
          startedAt: 200,
          trigger: 'model_change',
          calls: [{ ...baseCall, id: 'c2', timestamp: 200 }],
        }),
      ],
    )
    const groups = groupBySegment(rows)
    expect(groups).toHaveLength(2)
    expect(groups[0]?.segment.id).toBe('seg1')
    expect(groups[1]?.segment.id).toBe('seg2')
    expect(groups[1]?.segment.trigger).toBe('model_change')
  })

  it('隐式首段：segment 行之前的消息归入首段', () => {
    const rows = buildTimeline(
      [msg('m0', 10, [{ _tag: 'text', text: 'pre' }])],
      [seg({ startedAt: 50, calls: [] })],
    )
    const groups = groupBySegment(rows)
    expect(groups).toHaveLength(2)
    expect(groups[0]?.isFirst).toBe(true)
    expect(groups[0]?.messages.map((m) => m.message.id)).toEqual(['m0'])
  })

  it('latency 透传到 group messages', () => {
    const rows = buildTimeline(
      [msg('m', 100, [{ _tag: 'text', text: 'x' }])],
      [seg({ calls: [{ ...baseCall, id: 'c1', timestamp: 50 }] })],
    )
    const groups = groupBySegment(rows)
    expect(groups[0]?.messages[0]?.latency).toBe(1500)
  })
})

describe('userMessageText', () => {
  it('拼接 text part', () => {
    const m = { ...msg('u1', 1, [{ _tag: 'text', text: '你好' }]), role: 'user' as const }
    expect(userMessageText(m)).toBe('你好')
  })

  it('拼接 text + steering part', () => {
    const m = {
      ...msg('u2', 1, [
        { _tag: 'text', text: '问题' },
        { _tag: 'steering', text: '补充' },
      ]),
      role: 'user' as const,
    }
    expect(userMessageText(m)).toBe('问题\n补充')
  })

  it('忽略非文本 part 并 trim', () => {
    const m = {
      ...msg('u3', 1, [
        { _tag: 'thinking', text: 'x' },
        { _tag: 'text', text: '  hi  ' },
      ]),
      role: 'user' as const,
    }
    expect(userMessageText(m)).toBe('hi')
  })

  it('无文本 part 返回空串', () => {
    const m = msg('u4', 1, [{ _tag: 'thinking', text: 'x' }])
    expect(userMessageText(m)).toBe('')
  })
})
