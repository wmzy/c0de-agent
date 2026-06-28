import type { Message, MessageContent } from '@shared/types/message.js'
import { describe, expect, it } from 'vitest'
import { normalizeParts } from './normalizeParts.js'

function msg(role: Message['role'], parts: MessageContent[]): Message {
  return { id: '1', sessionId: 's', role, content: parts, tokenCount: 0, createdAt: 1 }
}

describe('normalizeParts', () => {
  it('纯文本消息映射为 text 块', () => {
    const blocks = normalizeParts(msg('user', [{ _tag: 'text', text: 'hi' }]))
    expect(blocks).toEqual([{ type: 'text', role: 'user', text: 'hi' }])
  })

  it('thinking 映射为 thinking 块', () => {
    const blocks = normalizeParts(msg('assistant', [{ _tag: 'thinking', text: 'hmm' }]))
    expect(blocks).toEqual([{ type: 'thinking', text: 'hmm' }])
  })

  it('steering 映射为 steering 块', () => {
    const blocks = normalizeParts(msg('user', [{ _tag: 'steering', text: 's' }]))
    expect(blocks).toEqual([{ type: 'steering', text: 's' }])
  })

  it('tool_call + 同 id tool_result(success) 合并为 completed', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'tool_call', id: 't1', tool: 'read', input: { path: 'a.ts' } },
        { _tag: 'tool_result', id: 't1', tool: '', output: { _tag: 'success', output: 'x' } },
      ]),
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'tool',
      id: 't1',
      tool: 'read',
      input: { path: 'a.ts' },
      status: 'completed',
    })
  })

  it('tool_result(error) → error 状态', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'tool_call', id: 't2', tool: 'bash', input: { command: 'ls' } },
        { _tag: 'tool_result', id: 't2', tool: '', output: { _tag: 'error', error: 'boom' } },
      ]),
    )
    expect(blocks[0]).toMatchObject({ status: 'error' })
  })

  it('tool_result(permission_required) → paused 状态', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'tool_call', id: 't3', tool: 'edit', input: {} },
        {
          _tag: 'tool_result',
          id: 't3',
          tool: '',
          output: { _tag: 'permission_required', reason: 'r' },
        },
      ]),
    )
    expect(blocks[0]).toMatchObject({ status: 'paused' })
  })

  it('truncated 结果也算 completed', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'tool_call', id: 't4', tool: 'grep', input: {} },
        {
          _tag: 'tool_result',
          id: 't4',
          tool: '',
          output: { _tag: 'truncated', output: 'o', truncated: true, totalLines: 100 },
        },
      ]),
    )
    expect(blocks[0]).toMatchObject({ status: 'completed' })
  })

  it('仅有 tool_call 无 result → running 状态', () => {
    const blocks = normalizeParts(
      msg('assistant', [{ _tag: 'tool_call', id: 't5', tool: 'read', input: {} }]),
    )
    expect(blocks[0]).toMatchObject({ status: 'running' })
  })

  it('孤立的 tool_result（无对应 call）仍渲染为 tool 块', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        {
          _tag: 'tool_result',
          id: 't6',
          tool: 'glob',
          output: { _tag: 'success', output: 'f.ts' },
        },
      ]),
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'tool', id: 't6', tool: 'glob', status: 'completed' })
  })

  it('混合多 part 保持顺序', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'text', text: 'a' },
        { _tag: 'tool_call', id: 't7', tool: 'read', input: {} },
        { _tag: 'tool_result', id: 't7', tool: '', output: { _tag: 'success', output: 'r' } },
        { _tag: 'text', text: 'b' },
      ]),
    )
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool', 'text'])
  })
})
