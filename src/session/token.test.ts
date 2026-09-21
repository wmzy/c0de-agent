import { describe, expect, it } from 'vitest'
import type { MessageContent } from '../shared/types/message.js'
import { estimateMessageTokens, estimateTokens } from './token.js'

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('estimates English text at ~4 chars/token', () => {
    expect(estimateTokens('hello world!')).toBe(3) // 12 chars / 4 = 3
  })

  it('estimates CJK characters at ~2 tokens each', () => {
    // 4 CJK chars → 4 × 2 = 8 tokens
    expect(estimateTokens('你好世界')).toBe(8)
  })

  it('handles mixed CJK and ASCII', () => {
    // '你好' (2 CJK → 4) + 'ab' (2 ASCII → 0.5 → ceil to 1) = 5
    expect(estimateTokens('你好ab')).toBe(5)
  })
})

describe('estimateMessageTokens', () => {
  it('sums tokens across content parts', () => {
    const content: MessageContent[] = [
      { _tag: 'text', text: 'hello' }, // 2
      { _tag: 'thinking', text: 'world' }, // 2
    ]
    expect(estimateMessageTokens(content)).toBe(4)
  })

  it('handles tool_call parts by stringifying input', () => {
    const content: MessageContent[] = [
      { _tag: 'tool_call', id: 't1', tool: 'read', input: { path: '/a.ts' } },
    ]
    expect(estimateMessageTokens(content)).toBeGreaterThan(0)
  })

  it('handles tool_result parts by stringifying output', () => {
    const content: MessageContent[] = [
      {
        _tag: 'tool_result',
        id: 't1',
        tool: 'read',
        output: { _tag: 'success', output: 'file content here' },
      },
    ]
    expect(estimateMessageTokens(content)).toBeGreaterThan(0)
  })

  // 回归：image 部分是 MessageContent 联合的正式成员，此前 switch 无对应 case——
  // 图片消息恒按 0 token 计，预算护栏/压缩窗口把图片轮次当免费（真实开销约
  // 1100 token/张），预算与压缩口径系统性低估。
  it('counts image parts (provider charges ~1100 tokens per image)', () => {
    const content: MessageContent[] = [
      { _tag: 'image', mediaType: 'image/png', data: 'AAAA' },
      { _tag: 'image', mediaType: 'image/png', data: 'BBBB' },
    ]
    expect(estimateMessageTokens(content)).toBe(1100 * 2)
  })

  it('image-only message counts toward the estimate', () => {
    const content: MessageContent[] = [
      { _tag: 'text', text: 'describe this' },
      { _tag: 'image', mediaType: 'image/png', data: 'AAAA' },
    ]
    expect(estimateMessageTokens(content)).toBeGreaterThan(1100)
  })

  it('returns 0 for empty content', () => {
    expect(estimateMessageTokens([])).toBe(0)
  })

  // 回归：import sanitizeContent 只校验 _tag 是字符串——缺 input 的 tool_call
  // 或缺 output 的 tool_result 分片会原样入库。此后 rawMessageTokens 走
  // estimateMessageTokens 时 JSON.stringify(undefined) 返回 undefined（非字符串），
  // estimateTokens 对其读 .length 抛 TypeError——整轮 agent run 在预算拟合处
  // 崩溃（导入的历史会话每次续聊都炸）。缺字段分片应保守按 0 token 计。
  it('tolerates tool_call parts with missing input (no crash, zero tokens)', () => {
    const content = [
      // 运行时漂移数据（import sanitizeContent 只校验 _tag）：类型层面 input
      // 恒存在，但实际入库行可能缺省——按运行时形状构造。
      { _tag: 'tool_call', id: 't1', tool: 'view', input: undefined },
    ] as unknown as MessageContent[]
    expect(() => estimateMessageTokens(content)).not.toThrow()
    expect(estimateMessageTokens(content)).toBe(0)
  })

  it('tolerates tool_result parts with missing output (no crash, zero tokens)', () => {
    const content = [
      { _tag: 'tool_result', id: 't1', tool: 'read', output: undefined },
    ] as unknown as MessageContent[]
    expect(() => estimateMessageTokens(content)).not.toThrow()
    expect(estimateMessageTokens(content)).toBe(0)
  })
})
