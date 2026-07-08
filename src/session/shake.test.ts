// shake.ts 单元测试。新建文件（shake 是全新模块，无既有测试可归入）。
// 归并建议：如未来 shake 逻辑并入 compaction.ts，本测试归入 compaction.test.ts。
import { describe, expect, it } from 'vitest'
import type { Message } from '../shared/types/message.js'
import {
  applyShakeRegions,
  collectShakeRegions,
  type ShakeConfig,
  scanTextForBlockRanges,
  toRegionViews,
} from './shake.js'

/** 构造 tool_result 消息。 */
function toolResultMessage(
  tool: string,
  output: string,
  opts: { id?: string; shakenAt?: number } = {},
): Message {
  return {
    id: opts.id ?? `msg-${Math.random().toString(36).slice(2)}`,
    sessionId: 's',
    role: 'tool',
    content: [
      {
        _tag: 'tool_result',
        id: 'call-1',
        tool,
        output: { _tag: 'success' as const, output, shakenAt: opts.shakenAt },
      },
    ],
    tokenCount: 0,
    createdAt: 0,
  }
}

/** 构造 assistant 文本消息。 */
function assistantMessage(text: string, opts: { id?: string } = {}): Message {
  return {
    id: opts.id ?? `msg-${Math.random().toString(36).slice(2)}`,
    sessionId: 's',
    role: 'assistant',
    content: [{ _tag: 'text' as const, text }],
    tokenCount: 0,
    createdAt: 0,
  }
}

/** 测试配置：保护窗口=0（全部候选）、minSavings=0、fenceMinTokens=50。 */
function cfg(over: Partial<ShakeConfig> = {}): ShakeConfig {
  return { protectTokens: 0, minSavings: 0, fenceMinTokens: 50, protectedTools: [], ...over }
}

/** 重复一行代码直到约 approxTokens token。 */
function fencedBlock(approxTokens: number, lang = 'ts'): string {
  const line = 'const value = computeSomething(alpha, beta, gamma, delta, epsilon);'
  const count = Math.ceil((approxTokens * 4) / line.length)
  return `\`\`\`${lang}\n${Array(count).fill(line).join('\n')}\n\`\`\``
}

describe('scanTextForBlockRanges', () => {
  it('检测闭合围栏块', () => {
    const text = 'intro\n```ts\nconst a = 1;\n```\noutro'
    const ranges = scanTextForBlockRanges(text)
    expect(ranges).toHaveLength(1)
    expect(text.slice(ranges[0]!.start, ranges[0]!.end)).toBe('```ts\nconst a = 1;\n```')
  })

  it('未闭合围栏不产生 range', () => {
    const text = 'intro\n```ts\nconst a = 1;\nconst b = 2;'
    expect(scanTextForBlockRanges(text)).toHaveLength(0)
  })

  it('检测顶层 XML 块', () => {
    const text = 'before\n<example>\nrow1\n</example>\nafter'
    const ranges = scanTextForBlockRanges(text)
    expect(ranges).toHaveLength(1)
    expect(text.slice(ranges[0]!.start, ranges[0]!.end)).toBe('<example>\nrow1\n</example>')
  })

  it('围栏内 XML 不重复检测', () => {
    const text = '```ts\nconst x = `<root>\ndata\n</root>`\n```'
    const ranges = scanTextForBlockRanges(text)
    expect(ranges).toHaveLength(1)
    expect(text.slice(ranges[0]!.start, ranges[0]!.end)).toBe(
      '```ts\nconst x = `<root>\ndata\n</root>`\n```',
    )
  })

  it('多个不重叠块各产生 range', () => {
    const text = '```\nblock1\n```\nmiddle\n```\nblock2\n```'
    const ranges = scanTextForBlockRanges(text)
    expect(ranges).toHaveLength(2)
  })

  it('空文本返回空数组', () => {
    expect(scanTextForBlockRanges('')).toHaveLength(0)
  })
})

describe('collectShakeRegions — tool results', () => {
  it('标记超出保护窗口的大 tool_result', () => {
    const msg = toolResultMessage('bash', 'x'.repeat(400))
    const regions = collectShakeRegions([msg], cfg())
    expect(regions).toHaveLength(1)
    expect(regions[0]!.kind).toBe('toolResult')
    expect(regions[0]!.label).toBe('bash')
    expect(regions[0]!.tokens).toBeGreaterThan(0)
  })

  it('保护窗口内的 tool_result 不被标记', () => {
    const text = 'word '.repeat(160) // ~200 token
    const older = toolResultMessage('bash', text)
    const recent = toolResultMessage('bash', text)
    const perEntry = Math.ceil(text.length / 4)
    const regions = collectShakeRegions([older, recent], cfg({ protectTokens: perEntry - 1 }))
    expect(regions).toHaveLength(1)
    expect(regions[0]!.messageId).toBe(older.id)
  })

  it('已标记 shakenAt 的不重复标记', () => {
    const msg = toolResultMessage('bash', 'z'.repeat(800), { shakenAt: Date.now() })
    expect(collectShakeRegions([msg], cfg())).toHaveLength(0)
  })

  it('protectedTools 被排除', () => {
    const msg = toolResultMessage('skill', 'y'.repeat(800))
    expect(collectShakeRegions([msg], cfg({ protectedTools: ['skill'] }))).toHaveLength(0)
  })

  it('minSavings 不足时返回空', () => {
    const msg = toolResultMessage('bash', 'q'.repeat(800))
    const tokens = Math.ceil(800 / 4)
    expect(collectShakeRegions([msg], cfg({ minSavings: tokens * 10 }))).toHaveLength(0)
  })

  it('fenceMinTokens 以下的小 tool_result 不标记', () => {
    const msg = toolResultMessage('bash', 'short')
    expect(collectShakeRegions([msg], cfg({ fenceMinTokens: 400 }))).toHaveLength(0)
  })
})

describe('collectShakeRegions — fenced/XML blocks', () => {
  it('标记大 fenced 块', () => {
    const fence = fencedBlock(120)
    const msg = assistantMessage(`intro line\n${fence}\noutro line`)
    const regions = collectShakeRegions([msg], cfg())
    expect(regions).toHaveLength(1)
    expect(regions[0]!.kind).toBe('block')
    if (regions[0]!.kind !== 'block') throw new Error('expected block region')
    expect(regions[0]!.originalText).toBe(fence)
  })

  it('fenceMinTokens 以下的 fenced 块不标记', () => {
    const msg = assistantMessage('intro\n```ts\nconst a = 1;\n```\noutro')
    expect(collectShakeRegions([msg], cfg({ fenceMinTokens: 400 }))).toHaveLength(0)
  })

  it('标记顶层 XML 块', () => {
    const xml = '<example>\n' + '  payload row data alpha beta gamma.\n'.repeat(12) + '</example>'
    const msg = assistantMessage(`before\n${xml}\nafter`)
    const regions = collectShakeRegions([msg], cfg())
    expect(regions).toHaveLength(1)
    expect(regions[0]!.kind).toBe('block')
    if (regions[0]!.kind !== 'block') throw new Error('expected block region')
    expect(regions[0]!.originalText).toBe(xml)
  })

  it('thinking 块也被扫描', () => {
    const fence = fencedBlock(120)
    const msg: Message = {
      id: 'msg-think',
      sessionId: 's',
      role: 'assistant',
      content: [{ _tag: 'thinking', text: `pre\n${fence}\npost` }],
      tokenCount: 0,
      createdAt: 0,
    }
    const regions = collectShakeRegions([msg], cfg())
    expect(regions).toHaveLength(1)
    expect(regions[0]!.partIndex).toBe(0)
  })
})

describe('applyShakeRegions', () => {
  it('tool_result 被替换为 placeholder 并加 shakenAt', () => {
    const msg = toolResultMessage('bash', 'huge output '.repeat(100))
    const regions = collectShakeRegions([msg], cfg())
    expect(regions).toHaveLength(1)

    const result = applyShakeRegions([msg], regions)
    expect(result).not.toBe([msg])
    const output = result[0]!.content[0]!
    expect(output._tag).toBe('tool_result')
    if (output._tag === 'tool_result') {
      expect(output.output._tag).toBe('success')
      if (output.output._tag === 'success') {
        expect(output.output.output).toBe('[shaken: bash, 300 tokens]')
        expect(output.output.shakenAt).toBeGreaterThan(0)
      }
    }
  })

  it('block 被原位 splice', () => {
    const fence = fencedBlock(120)
    const msg = assistantMessage(`head\n${fence}\ntail`)
    const regions = collectShakeRegions([msg], cfg())
    expect(regions).toHaveLength(1)

    const result = applyShakeRegions([msg], regions)
    const block = result[0]!.content[0]!
    expect(block._tag).toBe('text')
    if (block._tag === 'text') {
      expect(block.text).toBe(`head\n[shaken]\ntail`)
    }
  })

  it('同一 text block 多个 region 按降序 splice（偏移正确）', () => {
    const first = fencedBlock(80)
    const second = fencedBlock(80, 'py')
    const msg = assistantMessage(`head\n${first}\nmiddle\n${second}\ntail`)
    const regions = collectShakeRegions([msg], cfg())
    expect(regions).toHaveLength(2)

    const result = applyShakeRegions([msg], regions)
    const block = result[0]!.content[0]!
    expect(block._tag).toBe('text')
    if (block._tag === 'text') {
      expect(block.text).toBe('head\n[shaken]\nmiddle\n[shaken]\ntail')
    }
  })

  it('原数组不变（不可变）', () => {
    const msg = toolResultMessage('bash', 'huge output '.repeat(100))
    const originalOutput = (msg.content[0] as { output: { output: string } }).output.output
    const regions = collectShakeRegions([msg], cfg())
    applyShakeRegions([msg], regions)
    expect((msg.content[0] as { output: { output: string } }).output.output).toBe(originalOutput)
  })
})

describe('toRegionViews', () => {
  it('转换区域为前端视图', () => {
    const msg = toolResultMessage('bash', 'huge output '.repeat(100))
    const messages = [msg]
    const regions = collectShakeRegions(messages, cfg())
    const views = toRegionViews(regions, cfg(), messages)
    expect(views).toHaveLength(1)
    expect(views[0]!.id).toBe(regions[0]!.id)
    expect(views[0]!.kind).toBe('toolResult')
    expect(views[0]!.tokens).toBe(regions[0]!.tokens)
    expect(views[0]!.label).toBe('bash')
    expect(views[0]!.preview).toContain('huge output')
    expect(views[0]!.preview.length).toBeLessThanOrEqual(200)
    expect(views[0]!.placeholder).toContain('shaken')
    expect(views[0]!.isAfterProtectWindow).toBe(true)
  })

  it('preview 截断到 200 字符', () => {
    const msg = toolResultMessage('bash', 'x'.repeat(1000))
    const messages = [msg]
    const regions = collectShakeRegions(messages, cfg())
    const views = toRegionViews(regions, cfg(), messages)
    expect(views[0]!.preview.length).toBeLessThanOrEqual(200)
  })
})
