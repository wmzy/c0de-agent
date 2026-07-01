import type { LLMCall, LLMSegment } from '@shared/types/agent.js'
import type { Message } from '@shared/types/message.js'
import { describe, expect, it } from 'vitest'
import { buildTimeline, isEmptyMessage, type TimelineRow } from './timeline.js'

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
