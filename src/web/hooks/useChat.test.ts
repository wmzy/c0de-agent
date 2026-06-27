import type { AgentError } from '@shared/types/agent.js'
import type { Message, MessageContent } from '@shared/types/message.js'
import { describe, expect, it } from 'vitest'
import type { ChatState } from './useChat.js'
import { reduceChatEvent } from './useChat.js'

const base: ChatState = {
  messages: [],
  isStreaming: true,
  usage: null,
  error: null,
  pendingPermission: null,
}

function asst(parts: MessageContent[]): Message[] {
  return [
    {
      id: 'a1',
      sessionId: 's',
      role: 'assistant',
      content: parts,
      tokenCount: 0,
      createdAt: 1,
    },
  ]
}

describe('reduceChatEvent', () => {
  it('text_delta 追加到新 assistant 消息', () => {
    const s = reduceChatEvent(base, { _tag: 'text_delta', text: 'hi' })
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]?.content[0]).toEqual({ _tag: 'text', text: 'hi' })
  })

  it('连续 text_delta 累积到同一 text part', () => {
    let s = reduceChatEvent(base, { _tag: 'text_delta', text: 'a' })
    s = reduceChatEvent(s, { _tag: 'text_delta', text: 'b' })
    expect(s.messages[0]?.content[0]).toEqual({ _tag: 'text', text: 'ab' })
  })

  it('tool_call_start + tool_call_end 配对成结果', () => {
    let s = reduceChatEvent(base, { _tag: 'text_delta', text: 'x' })
    s = reduceChatEvent(s, { _tag: 'tool_call_start', id: 't1', tool: 'read', input: {} })
    expect(s.messages[0]?.content).toHaveLength(2)
    s = reduceChatEvent(s, {
      _tag: 'tool_call_end',
      id: 't1',
      result: { _tag: 'success', output: 'ok' },
    })
    const parts = s.messages[0]?.content
    const result = parts?.find((p) => p._tag === 'tool_result')
    expect(result && result._tag === 'tool_result' ? result.output._tag : null).toBe('success')
  })

  it('thinking 作为独立 part', () => {
    const s = reduceChatEvent(
      { ...base, messages: asst([{ _tag: 'text', text: 'hi' }]) },
      { _tag: 'thinking', text: 'hmm' },
    )
    expect(s.messages[0]?.content[1]).toEqual({ _tag: 'thinking', text: 'hmm' })
  })

  it('usage 更新', () => {
    const s = reduceChatEvent(base, { _tag: 'usage', input: 10, output: 5 })
    expect(s.usage).toEqual({ input: 10, output: 5 })
  })

  it('done 结束流式', () => {
    const s = reduceChatEvent(base, { _tag: 'done' })
    expect(s.isStreaming).toBe(false)
  })

  it('error 转消息', () => {
    const err: AgentError = { _tag: 'provider', message: 'boom', retryable: false }
    const s = reduceChatEvent(base, { _tag: 'error', error: err })
    expect(s.error).toBe('boom')
  })

  it('permission_required 设置 pending', () => {
    const s = reduceChatEvent(base, {
      _tag: 'permission_required',
      toolCallId: 'p1',
      tool: 'bash',
      input: {},
    })
    expect(s.pendingPermission).toEqual({ toolCallId: 'p1', tool: 'bash' })
  })
})
