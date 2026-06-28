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

  it('多个并行工具结果渲染为结构化块，绝不字符串化为 [object Promise]', () => {
    // 回归：并行工具调用的结果必须渲染为结构化 ToolResult 对象，
    // 而非把 Promise/对象字符串化为 "[object Promise]"（曾出现于工具结果展示）。
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'tool_call', id: 'p1', tool: 'bash', input: { command: 'ls' } },
        { _tag: 'tool_call', id: 'p2', tool: 'bash', input: { command: 'pwd' } },
        { _tag: 'tool_call', id: 'p3', tool: 'bash', input: { command: 'cat x' } },
        { _tag: 'tool_result', id: 'p1', tool: '', output: { _tag: 'success', output: 'a\nb' } },
        { _tag: 'tool_result', id: 'p2', tool: '', output: { _tag: 'success', output: '/proj' } },
        { _tag: 'tool_result', id: 'p3', tool: '', output: { _tag: 'error', error: 'no file' } },
      ]),
    )
    const toolBlocks = blocks.filter((b) => b.type === 'tool')
    expect(toolBlocks).toHaveLength(3)
    // 每个 output 必须是结构化 ToolResult（带 _tag），不是字符串
    for (const tb of toolBlocks) {
      const out = (tb as { output?: unknown }).output
      expect(out).toBeTypeOf('object')
      expect(out).not.toBeNull()
      expect((out as { _tag?: string })._tag).toBeDefined()
    }
    // 锁定不变量：渲染块序列化后绝不出现 "[object Promise]" / "[object Object]"
    expect(JSON.stringify(blocks)).not.toContain('[object Promise]')
    expect(JSON.stringify(blocks)).not.toContain('[object Object]')
  })
})
