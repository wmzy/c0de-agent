# Shake 压缩实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现零 LLM 调用的机械式内容裁剪（shake）——把重型工具输出和大文本块原位替换为占位符，与现有 LLM 摘要 compaction 互补。

**Architecture:** 新增纯逻辑层 `src/session/shake.ts`（移植 omp，适配 flat `Message[]`），复用 `compactionArchives` 表归档原始内容（`archiveType: 'shake'`）。后端两个 API（preview + apply），前端 `ShakePanel` 组件提供勾选/全选/选当前及以下/预览效果/提交流程。

**Tech Stack:** TypeScript, Drizzle ORM (PGLite), Hono, React 19, @linaria, Vitest

**Spec:** `docs/superpowers/specs/2026-07-08-shake-compaction-design.md`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/session/shake.ts` | **新建**：`ShakeConfig`/`ShakeRegion`/`ShakeRegionView` 类型 + `collectShakeRegions` + `scanTextForBlockRanges` + `applyShakeRegions` + `DEFAULT_SHAKE_CONFIG` |
| `src/session/shake.test.ts` | **新建**：纯函数单元测试 |
| `src/shared/types/tool.ts` | 修改：`ToolResult` 各 variant 加 `shakenAt?: number` |
| `src/session/archive.ts` | 修改：`archiveType` 参数类型加 `'shake'` |
| `src/server/routes/session.ts` | 修改：加 `POST /:id/shake/preview` + `POST /:id/shake/apply` |
| `src/server/routes/session.test.ts` | 修改：追加 shake 集成测试 |
| `src/web/services/session.ts` | 修改：加 `shakePreview`/`shakeApply` |
| `src/web/types/index.ts` | 修改：加 `ShakeRegionView` 类型 |
| `src/web/components/ShakePanel.tsx` | **新建**：勾选面板 |
| `src/web/components/ShakePanel.test.tsx` | **新建**：面板测试 |
| `src/web/views/ChatView.tsx` | 修改：加 Shake 按钮 + ShakePanel |

---

## Task 1: ToolResult 加 shakenAt 字段

**Files:**
- Modify: `src/shared/types/tool.ts:9-12`

- [ ] **Step 1: 修改 ToolResult 类型**

```typescript
// src/shared/types/tool.ts:9-12，替换整个 ToolResult 类型
type ToolResult =
  | { _tag: 'success'; output: string; metadata?: Record<string, unknown>; shakenAt?: number }
  | { _tag: 'error'; error: string; shakenAt?: number }
  | { _tag: 'permission_required'; reason: string }
  | { _tag: 'truncated'; output: string; truncated: boolean; totalLines: number; shakenAt?: number }
```

- [ ] **Step 2: 验证类型检查通过**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/tool.ts
git commit -m "feat(types): add shakenAt to ToolResult for shake compaction"
```

---

## Task 2: archive.ts 支持 'shake' archiveType

**Files:**
- Modify: `src/session/archive.ts`（`archiveOriginalEntries` 函数签名）

- [ ] **Step 1: 找到 `archiveOriginalEntries` 函数签名并修改 archiveType 参数类型**

当前签名（`src/session/archive.ts`，`archiveOriginalEntries` 函数）：
```typescript
archiveType: 'compaction' | 'squash',
```
改为：
```typescript
archiveType: 'compaction' | 'squash' | 'shake',
```

- [ ] **Step 2: 验证类型检查通过**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/session/archive.ts
git commit -m "feat(archive): support 'shake' archiveType"
```

---

## Task 3: scanTextForBlockRanges — 纯函数检测围栏/XML 块

**Files:**
- Create: `src/session/shake.ts`
- Test: `src/session/shake.test.ts`

- [ ] **Step 1: 写失败测试 — scanTextForBlockRanges**

创建 `src/session/shake.test.ts`：

```typescript
// shake.ts 单元测试。新建文件（shake 是全新模块，无既有测试可归入）。
// 归并建议：如未来 shake 逻辑并入 compaction.ts，本测试归入 compaction.test.ts。
import { describe, expect, it } from 'vitest'
import { scanTextForBlockRanges } from './shake.js'

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
    // 只检测到外层围栏，围栏内的 <root> 不再产生独立 range
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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/session/shake.test.ts`
Expected: FAIL — `Cannot find module './shake.js'`

- [ ] **Step 3: 实现 shake.ts 的 scanTextForBlockRanges**

创建 `src/session/shake.ts`：

```typescript
import { estimateTokens } from './token.js'
import type { Message, MessageContent } from '../shared/types/message.js'
import type { ToolResult } from '../shared/types/tool.js'

/** Rough token cost of a placeholder line; used only for the savings gate. */
const PLACEHOLDER_TOKEN_ESTIMATE = 16

/** 识别 fenced 代码块和顶层 XML 元素的正则（小写 tag，保守策略）。 */
const OPENING_XML = /^<([a-z_-]+)(?:\s+[^>]*)?>$/
const CLOSING_XML = /^<\/([a-z_-]+)>$/

export interface ShakeConfig {
  /** 保护最近 N token 的上下文不被 shake。 */
  protectTokens: number
  /** 总节省 token < minSavings 时不 shake（preview 路径用）。 */
  minSavings: number
  /** fenced/XML block 的最小 token 阈值。 */
  fenceMinTokens: number
  /** 受保护的工具名列表（其 tool_result 不被 shake）。 */
  protectedTools: string[]
}

/** Auto-shake 默认配置：保护活跃尾部，保守阈值。 */
export const DEFAULT_SHAKE_CONFIG: ShakeConfig = {
  protectTokens: 16_000,
  minSavings: 4_000,
  fenceMinTokens: 400,
  protectedTools: [],
}

export type ShakeRegion =
  | {
      kind: 'toolResult'
      id: string
      messageId: string
      messageIndex: number
      partIndex: number
      tokens: number
      originalText: string
      label: string
    }
  | {
      kind: 'block'
      id: string
      messageId: string
      messageIndex: number
      partIndex: number
      start: number
      end: number
      tokens: number
      originalText: string
      label: string
    }

/** API 返回给前端的区域视图。 */
export type ShakeRegionView = {
  id: string
  kind: 'toolResult' | 'block'
  messageId: string
  messageIndex: number
  tokens: number
  label: string
  preview: string
  placeholder: string
  isAfterProtectWindow: boolean
}

/**
 * 定位 fenced 代码块和顶层 XML 元素 span。返回字符偏移 [start, end) 数组，
 * 覆盖完整块（含围栏/标签行，不含尾换行）。围栏内抑制 XML 检测。
 * 未闭合围栏/标签不产生 range（保守策略）。
 */
export function scanTextForBlockRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let inFence = false
  let fenceStart = -1
  const tagStack: string[] = []
  let xmlStart = -1

  let lineStart = 0
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== '\n') continue
    const line = text.slice(lineStart, i)
    const lineEnd = i
    const trimmedStart = line.trimStart()

    const isFenceLine = trimmedStart.startsWith('```') || trimmedStart.startsWith('~~~')
    if (isFenceLine) {
      if (!inFence) {
        inFence = true
        fenceStart = lineStart
      } else {
        inFence = false
        ranges.push({ start: fenceStart, end: lineEnd })
        fenceStart = -1
      }
      lineStart = i + 1
      continue
    }

    if (!inFence) {
      const isOpeningXml = line.length === trimmedStart.length && OPENING_XML.test(trimmedStart)
      if (isOpeningXml) {
        const match = OPENING_XML.exec(trimmedStart)
        if (match) {
          if (tagStack.length === 0) xmlStart = lineStart
          tagStack.push(match[1])
        }
      } else {
        const closingMatch = CLOSING_XML.exec(trimmedStart)
        if (closingMatch && tagStack.length > 0 && tagStack[tagStack.length - 1] === closingMatch[1]) {
          tagStack.pop()
          if (tagStack.length === 0 && xmlStart >= 0) {
            ranges.push({ start: xmlStart, end: lineEnd })
            xmlStart = -1
          }
        }
      }
    }

    lineStart = i + 1
  }

  return mergeRanges(ranges)
}

/** 按 start 升序，丢弃与已保留范围重叠的（嵌套取最外层）。 */
function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (ranges.length <= 1) return ranges
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const kept: Array<{ start: number; end: number }> = []
  let lastEnd = -1
  for (const range of sorted) {
    if (range.start < lastEnd) continue
    kept.push(range)
    lastEnd = range.end
  }
  return kept
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run src/session/shake.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/session/shake.ts src/session/shake.test.ts
git commit -m "feat(shake): scanTextForBlockRanges — fenced/XML block detection"
```

---

## Task 4: collectShakeRegions — 区域收集

**Files:**
- Modify: `src/session/shake.ts`
- Modify: `src/session/shake.test.ts`

- [ ] **Step 1: 写失败测试 — collectShakeRegions toolResult**

追加到 `src/session/shake.test.ts`：

```typescript
import { collectShakeRegions, type ShakeConfig } from './shake.js'
import type { Message } from '../shared/types/message.js'

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
    content: [{ _tag: 'tool_result', id: 'call-1', tool, output: { _tag: 'success', output, shakenAt: opts.shakenAt } }],
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
    content: [{ _tag: 'text', text }],
    tokenCount: 0,
    createdAt: 0,
  }
}

/** 测试配置：保护窗口=0（全部候选）、minSavings=0、fenceMinTokens=50。 */
function cfg(over: Partial<ShakeConfig> = {}): ShakeConfig {
  return { protectTokens: 0, minSavings: 0, fenceMinTokens: 50, protectedTools: [], ...over }
}

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
    // 窗口覆盖最近 ~1.5 条 → recent 受保护
    const regions = collectShakeRegions([older, recent], cfg({ protectTokens: Math.floor(perEntry * 1.5) }))
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
```

- [ ] **Step 2: 写失败测试 — collectShakeRegions fenced/XML blocks**

追加到 `src/session/shake.test.ts`：

```typescript
/** 重复一行代码直到约 approxTokens token。 */
function fencedBlock(approxTokens: number, lang = 'ts'): string {
  const line = 'const value = computeSomething(alpha, beta, gamma, delta, epsilon);'
  const count = Math.ceil((approxTokens * 4) / line.length)
  return `\`\`\`${lang}\n${Array(count).fill(line).join('\n')}\n\`\`\``
}

describe('collectShakeRegions — fenced/XML blocks', () => {
  it('标记大 fenced 块', () => {
    const fence = fencedBlock(120)
    const msg = assistantMessage(`intro line\n${fence}\noutro line`)
    const regions = collectShakeRegions([msg], cfg())
    expect(regions).toHaveLength(1)
    expect(regions[0]!.kind).toBe('block')
    if (regions[0]!.kind !== 'block') throw new Error('expected block region')
    // originalText 应等于 fence
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
```

- [ ] **Step 3: 运行测试验证失败**

Run: `npx vitest run src/session/shake.test.ts`
Expected: FAIL — `collectShakeRegions is not a function`

- [ ] **Step 4: 实现 collectShakeRegions**

追加到 `src/session/shake.ts`（在 `scanTextForBlockRanges` 函数之后）：

```typescript
/** 单条消息的 token 估算。 */
function messageTokens(m: Message): number {
  if (m.tokenCount > 0) return m.tokenCount
  return m.content.reduce((sum, part) => {
    switch (part._tag) {
      case 'text':
      case 'thinking':
      case 'steering':
        return sum + estimateTokens(part.text)
      case 'tool_call':
        return sum + estimateTokens(JSON.stringify(part.input))
      case 'tool_result':
        return sum + estimateTokens(JSON.stringify(part.output))
      default:
        return sum
    }
  }, 0)
}

/** tool_result part 的输出文本。 */
function toolResultText(output: ToolResult): string {
  if (output._tag === 'success') return output.output
  if (output._tag === 'error') return output.error
  if (output._tag === 'truncated') return output.output
  return ''
}

/** 收集可 shake 的区域。纯函数，不修改输入。 */
export function collectShakeRegions(messages: Message[], config: ShakeConfig): ShakeRegion[] {
  const n = messages.length
  if (n === 0) return []

  // accumulatedAfter[i] = i 之后所有 message 的 token 总和
  const accumulatedAfter = new Array<number>(n)
  let acc = 0
  for (let i = n - 1; i >= 0; i--) {
    accumulatedAfter[i] = acc
    acc += messageTokens(messages[i]!)
  }

  const regions: ShakeRegion[] = []

  for (let i = 0; i < n; i++) {
    const msg = messages[i]!
    const isAfterProtectWindow = accumulatedAfter[i]! >= config.protectTokens

    for (let partIndex = 0; partIndex < msg.content.length; partIndex++) {
      const part = msg.content[partIndex]!

      // tool_result 区域
      if (part._tag === 'tool_result') {
        if (isAfterProtectWindow) {
          // 已 shaken 跳过
          if ('shakenAt' in part.output && part.output.shakenAt) continue
          // protectedTools 跳过
          if (config.protectedTools.includes(part.tool)) continue
          const text = toolResultText(part.output)
          if (text.length === 0) continue
          const tokens = estimateTokens(text)
          if (tokens < config.fenceMinTokens) continue
          regions.push({
            kind: 'toolResult',
            id: `${msg.id}:toolResult:${partIndex}`,
            messageId: msg.id,
            messageIndex: i,
            partIndex,
            tokens,
            originalText: text,
            label: part.tool,
          })
        }
        continue
      }

      // text/thinking block 区域
      if ((part._tag === 'text' || part._tag === 'thinking') && isAfterProtectWindow) {
        const text = part.text
        for (const range of scanTextForBlockRanges(text)) {
          const slice = text.slice(range.start, range.end)
          if (slice.length === 0) continue
          const tokens = estimateTokens(slice)
          if (tokens < config.fenceMinTokens) continue
          regions.push({
            kind: 'block',
            id: `${msg.id}:block:${partIndex}:${range.start}`,
            messageId: msg.id,
            messageIndex: i,
            partIndex,
            start: range.start,
            end: range.end,
            tokens,
            originalText: slice,
            label: msg.role,
          })
        }
      }
    }
  }

  // minSavings 门控
  let savings = 0
  for (const region of regions) savings += Math.max(0, region.tokens - PLACEHOLDER_TOKEN_ESTIMATE)
  if (savings < config.minSavings) return []

  return regions
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `npx vitest run src/session/shake.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/session/shake.ts src/session/shake.test.ts
git commit -m "feat(shake): collectShakeRegions — tool result + fenced/XML block detection"
```

---

## Task 5: applyShakeRegions — 原位替换

**Files:**
- Modify: `src/session/shake.ts`
- Modify: `src/session/shake.test.ts`

- [ ] **Step 1: 写失败测试 — applyShakeRegions**

追加到 `src/session/shake.test.ts`：

```typescript
import { applyShakeRegions } from './shake.js'

describe('applyShakeRegions', () => {
  it('tool_result 被替换为 placeholder 并加 shakenAt', () => {
    const msg = toolResultMessage('bash', 'huge output '.repeat(100))
    const regions = collectShakeRegions([msg], cfg())
    expect(regions).toHaveLength(1)

    const result = applyShakeRegions([msg], regions)
    expect(result).not.toBe([msg]) // 新数组
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
    // 原数组中的 output 未变
    expect((msg.content[0] as { output: { output: string } }).output.output).toBe(originalOutput)
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/session/shake.test.ts`
Expected: FAIL — `applyShakeRegions is not a function`

- [ ] **Step 3: 实现 applyShakeRegions**

追加到 `src/session/shake.ts`（在 `collectShakeRegions` 之后）：

```typescript
/** 为区域生成占位符文本。 */
function placeholderFor(region: ShakeRegion): string {
  if (region.kind === 'toolResult') {
    return `[shaken: ${region.label}, ${region.tokens} tokens]`
  }
  return `[shaken]`
}

/** 原位替换选中区域。返回新数组，不修改原数组。 */
export function applyShakeRegions(messages: Message[], regions: ShakeRegion[]): Message[] {
  if (regions.length === 0) return messages

  // 按 messageId 分组
  const byMessage = new Map<string, ShakeRegion[]>()
  for (const region of regions) {
    const list = byMessage.get(region.messageId) ?? []
    list.push(region)
    byMessage.set(region.messageId, list)
  }

  return messages.map((msg) => {
    const msgRegions = byMessage.get(msg.id)
    if (!msgRegions) return msg

    // 深拷贝 content（结构化克隆保证不修改原对象）
    const newContent = structuredClone(msg.content) as MessageContent[]

    for (const region of msgRegions) {
      if (region.kind === 'toolResult') {
        const part = newContent[region.partIndex]
        if (part && part._tag === 'tool_result') {
          if (part.output._tag === 'success') {
            part.output = { ...part.output, output: placeholderFor(region), shakenAt: Date.now() }
          } else if (part.output._tag === 'error') {
            part.output = { ...part.output, error: placeholderFor(region), shakenAt: Date.now() }
          } else if (part.output._tag === 'truncated') {
            part.output = { ...part.output, output: placeholderFor(region), shakenAt: Date.now() }
          }
        }
      } else {
        // block：同一 text block 内按 start 降序 splice
        const blockRegions = msgRegions
          .filter((r) => r.kind === 'block' && r.partIndex === region.partIndex)
          .sort((a, b) => (b.start ?? 0) - (a.start ?? 0))
        const part = newContent[region.partIndex]
        if (part && (part._tag === 'text' || part._tag === 'thinking')) {
          let text = part.text
          for (const br of blockRegions) {
            if (br.kind !== 'block') continue
            text = text.slice(0, br.start) + placeholderFor(br) + text.slice(br.end)
          }
          part.text = text
        }
      }
    }

    return { ...msg, content: newContent }
  })
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run src/session/shake.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session/shake.ts src/session/shake.test.ts
git commit -m "feat(shake): applyShakeRegions — immutable in-place replacement"
```

---

## Task 6: toRegionViews — 区域转 API 视图

**Files:**
- Modify: `src/session/shake.ts`
- Modify: `src/session/shake.test.ts`

- [ ] **Step 1: 写失败测试 — toRegionViews**

追加到 `src/session/shake.test.ts`：

```typescript
import { toRegionViews } from './shake.js'

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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/session/shake.test.ts`
Expected: FAIL — `toRegionViews is not a function`

- [ ] **Step 3: 实现 toRegionViews**

追加到 `src/session/shake.ts`：

```typescript
/** 区域转 API 视图。protectWindow 窗口内的标记 isAfterProtectWindow=false。 */
export function toRegionViews(
  regions: ShakeRegion[],
  config: ShakeConfig,
  messages: Message[],
): ShakeRegionView[] {
  // 预计算 accumulatedAfter（与 collectShakeRegions 一致）
  const n = messages.length
  const accumulatedAfter = new Array<number>(n)
  let acc = 0
  for (let i = n - 1; i >= 0; i--) {
    accumulatedAfter[i] = acc
    acc += messageTokens(messages[i]!)
  }

  return regions.map((region) => ({
    id: region.id,
    kind: region.kind,
    messageId: region.messageId,
    messageIndex: region.messageIndex,
    tokens: region.tokens,
    label: region.label,
    preview: region.originalText.slice(0, 200),
    placeholder:
      region.kind === 'toolResult'
        ? `[shaken: ${region.label}, ${region.tokens} tokens]`
        : '[shaken]',
    isAfterProtectWindow: accumulatedAfter[region.messageIndex]! >= config.protectTokens,
  }))
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run src/session/shake.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session/shake.ts src/session/shake.test.ts
git commit -m "feat(shake): toRegionViews — region to API view mapping"
```

---

## Task 7: shake preview API

**Files:**
- Modify: `src/server/routes/session.ts`
- Modify: `src/server/routes/session.test.ts`

- [ ] **Step 1: 写失败测试 — shake/preview**

追加到 `src/server/routes/session.test.ts` 的 `describe('session route')` 块末尾：

```typescript
  it('POST /:id/shake/preview 返回可 shake 区域', async () => {
    const { app } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Shake' }),
    })
    const created = (await createRes.json()) as Session

    // 插入一个大 tool_result 消息
    const { appendMessage } = await import('../../session/message.js')
    await appendMessage(dbHandle!, created.id, {
      role: 'tool',
      content: [
        {
          _tag: 'tool_result',
          id: 'call-1',
          tool: 'bash',
          output: { _tag: 'success', output: 'x'.repeat(5000) },
        },
      ],
    })

    const res = await app.request(`/${created.id}/shake/preview`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { regions: Array<{ kind: string; tokens: number }> }
    expect(body.regions.length).toBeGreaterThan(0)
    expect(body.regions.some((r) => r.kind === 'toolResult')).toBe(true)
  })

  it('POST /:id/shake/preview 不存在的会话 → 404', async () => {
    const { app } = await setup()
    const res = await app.request('/nonexistent/shake/preview', { method: 'POST' })
    expect(res.status).toBe(404)
  })
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/server/routes/session.test.ts -t shake`
Expected: FAIL — 路由不存在（404 或 404 body 不对）

- [ ] **Step 3: 加 shake/preview 路由**

修改 `src/server/routes/session.ts`，在文件顶部 import 区加：

```typescript
import { collectShakeRegions, DEFAULT_SHAKE_CONFIG, toRegionViews } from '../../session/shake.js'
```

在 `createSessionRoute` 函数内，`// 获取分支` 注释前加：

```typescript
  // shake preview：返回可 shake 的区域列表
  app.post('/:id/shake/preview', async (c) => {
    const id = c.req.param('id')
    let session: Awaited<ReturnType<typeof getSession>>
    try {
      session = await getSession(ctx.db, id)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }
    if (!session) return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    const messages = await getMessages(ctx.db, id)
    const regions = collectShakeRegions(messages, DEFAULT_SHAKE_CONFIG)
    const views = toRegionViews(regions, DEFAULT_SHAKE_CONFIG, messages)
    return c.json({ regions: views })
  })
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run src/server/routes/session.test.ts -t shake`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/session.ts src/server/routes/session.test.ts
git commit -m "feat(server): POST /sessions/:id/shake/preview endpoint"
```

---

## Task 8: shake apply API

**Files:**
- Modify: `src/server/routes/session.ts`
- Modify: `src/server/routes/session.test.ts`

- [ ] **Step 1: 写失败测试 — shake/apply**

追加到 `src/server/routes/session.test.ts` 的 `describe('session route')` 块末尾：

```typescript
  it('POST /:id/shake/apply 归档并替换内容', async () => {
    const { app } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ShakeApply' }),
    })
    const created = (await createRes.json()) as Session

    const { appendMessage } = await import('../../session/message.js')
    await appendMessage(dbHandle!, created.id, {
      role: 'tool',
      content: [
        {
          _tag: 'tool_result',
          id: 'call-1',
          tool: 'bash',
          output: { _tag: 'success', output: 'x'.repeat(5000) },
        },
      ],
    })

    // preview 拿 regionId
    const previewRes = await app.request(`/${created.id}/shake/preview`, { method: 'POST' })
    const previewBody = (await previewRes.json()) as { regions: Array<{ id: string }> }
    const regionId = previewBody.regions[0]!.id

    // apply
    const applyRes = await app.request(`/${created.id}/shake/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regionIds: [regionId] }),
    })
    expect(applyRes.status).toBe(200)
    const applyBody = (await applyRes.json()) as { shaken: number; archiveId: string }
    expect(applyBody.shaken).toBe(1)
    expect(applyBody.archiveId).toBeTruthy()

    // 再次 preview：已 shaken 的不出现
    const previewRes2 = await app.request(`/${created.id}/shake/preview`, { method: 'POST' })
    const previewBody2 = (await previewRes2.json()) as { regions: unknown[] }
    expect(previewBody2.regions).toHaveLength(0)
  })

  it('POST /:id/shake/apply regionIds 不匹配 → 400', async () => {
    const { app } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Shake400' }),
    })
    const created = (await createRes.json()) as Session

    const res = await app.request(`/${created.id}/shake/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regionIds: ['nonexistent-id'] }),
    })
    expect(res.status).toBe(400)
  })
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/server/routes/session.test.ts -t shake`
Expected: FAIL — apply 路由不存在

- [ ] **Step 3: 加 shake/apply 路由**

修改 `src/server/routes/session.ts`，在文件顶部 import 区加：

```typescript
import { applyShakeRegions } from '../../session/shake.js'
import { archiveOriginalEntries } from '../../session/archive.js'
import { deleteEntriesByIds, insertEntry } from '../../session/message.js'
import { generateId } from '../../shared/index.js'
import { sessionEntries } from '../../db/schema.js'
import { estimateMessageTokens } from '../../session/token.js'
```

在 preview 路由后加 apply 路由：

```typescript
  // shake apply：归档原始内容 + 原位替换
  app.post('/:id/shake/apply', async (c) => {
    const id = c.req.param('id')
    let session: Awaited<ReturnType<typeof getSession>>
    try {
      session = await getSession(ctx.db, id)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }
    if (!session) return apiError(c, 404, 'NOT_FOUND', 'Session not found')

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const regionIds = (body.regionIds as string[] | undefined) ?? []

    const messages = await getMessages(ctx.db, id)
    const regions = collectShakeRegions(messages, DEFAULT_SHAKE_CONFIG)

    // 校验：所有 regionIds 必须命中当前 preview 结果（原子性）
    const availableIds = new Set(regions.map((r) => r.id))
    const unknownIds = regionIds.filter((rid) => !availableIds.has(rid))
    if (unknownIds.length > 0) {
      return apiError(c, 400, 'INVALID_REGIONS', '消息已变化，请重新预览')
    }

    // 过滤选中区域
    const selectedSet = new Set(regionIds)
    const selected = regions.filter((r) => selectedSet.has(r.id))
    if (selected.length === 0) {
      return c.json({ shaken: 0, archiveId: '' })
    }

    // 收集受影响的原始 message（用于归档）
    const affectedIds = [...new Set(selected.map((r) => r.messageId))]
    const originalMessages = messages.filter((m) => affectedIds.includes(m.id))

    // 归档原始内容
    const archiveId = generateId()
    const totalTokens = selected.reduce((sum, r) => sum + r.tokens, 0)
    await archiveOriginalEntries(
      ctx.db,
      id,
      originalMessages.map((m) => ({ _tag: 'message' as const, ...m })),
      'shake',
      `Shaken ${selected.length} regions, saved ${totalTokens} tokens`,
      archiveId,
    )

    // applyShakeRegions 得到新 messages
    const shakenMessages = applyShakeRegions(messages, selected)

    // 持久化：delete 旧 + insert 新（仅受影响的）
    await deleteEntriesByIds(ctx.db, affectedIds)
    for (const msg of shakenMessages) {
      if (!affectedIds.includes(msg.id)) continue
      await insertEntry(ctx.db, {
        id: msg.id,
        sessionId: id,
        tag: 'message',
        role: msg.role,
        content: msg.content,
        tokenCount: estimateMessageTokens(msg.content),
      })
    }

    return c.json({ shaken: selected.length, archiveId })
  })
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run src/server/routes/session.test.ts -t shake`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/session.ts src/server/routes/session.test.ts
git commit -m "feat(server): POST /sessions/:id/shake/apply endpoint"
```

---

## Task 9: 前端 API client + 类型

**Files:**
- Modify: `src/web/services/session.ts`
- Modify: `src/web/types/index.ts`

- [ ] **Step 1: 加 ShakeRegionView 类型到 types/index.ts**

在 `src/web/types/index.ts` 的 `SessionTreeNode` 类型定义后加：

```typescript
/** shake 区域视图（POST /sessions/:id/shake/preview 返回）。 */
type ShakeRegionView = {
  id: string
  kind: 'toolResult' | 'block'
  messageId: string
  messageIndex: number
  tokens: number
  label: string
  preview: string
  placeholder: string
  isAfterProtectWindow: boolean
}
```

在 export type 块中加 `ShakeRegionView`。

- [ ] **Step 2: 加 shake API 到 services/session.ts**

在 `src/web/services/session.ts` 的 `sessionAPI` 对象中，`compact` 后加：

```typescript
  shakePreview: (id: string) =>
    apiRequest<{ regions: ShakeRegionView[] }>(`/api/sessions/${id}/shake/preview`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  shakeApply: (id: string, regionIds: string[]) =>
    apiRequest<{ shaken: number; archiveId: string }>(`/api/sessions/${id}/shake/apply`, {
      method: 'POST',
      body: JSON.stringify({ regionIds }),
    }),
```

在文件顶部 import 加 `ShakeRegionView`：

```typescript
import type { ShakeRegionView, SessionTreeNode } from '../types/index.js'
```

- [ ] **Step 3: 验证类型检查通过**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/web/services/session.ts src/web/types/index.ts
git commit -m "feat(web): shake API client + ShakeRegionView type"
```

---

## Task 10: ShakePanel 组件

**Files:**
- Create: `src/web/components/ShakePanel.tsx`
- Create: `src/web/components/ShakePanel.test.tsx`

- [ ] **Step 1: 写失败测试 — ShakePanel 基础渲染**

创建 `src/web/components/ShakePanel.test.tsx`：

```typescript
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShakeRegionView } from '../types/index.js'
import { ShakePanel } from './ShakePanel.js'

afterEach(cleanup)

const regions: ShakeRegionView[] = [
  {
    id: 'msg1:toolResult:0',
    kind: 'toolResult',
    messageId: 'msg1',
    messageIndex: 0,
    tokens: 800,
    label: 'bash',
    preview: 'huge output...',
    placeholder: '[shaken: bash, 800 tokens]',
    isAfterProtectWindow: true,
  },
  {
    id: 'msg2:block:0:10',
    kind: 'block',
    messageId: 'msg2',
    messageIndex: 1,
    tokens: 500,
    label: 'assistant',
    preview: '```ts\n...',
    placeholder: '[shaken]',
    isAfterProtectWindow: false,
  },
]

describe('ShakePanel', () => {
  it('渲染 region 列表', () => {
    render(<ShakePanel regions={regions} onSubmit={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByTestId('shake-region-msg1:toolResult:0')).toBeTruthy()
    expect(screen.getByTestId('shake-region-msg2:block:0:10')).toBeTruthy()
  })

  it('默认勾选 isAfterProtectWindow=true 的 region', () => {
    render(<ShakePanel regions={regions} onSubmit={vi.fn()} onClose={vi.fn()} />)
    const checkbox1 = screen.getByTestId('shake-region-msg1:toolResult:0') as HTMLInputElement
    const checkbox2 = screen.getByTestId('shake-region-msg2:block:0:10') as HTMLInputElement
    expect(checkbox1.checked).toBe(true) // isAfterProtectWindow=true
    expect(checkbox2.checked).toBe(false) // isAfterProtectWindow=false
  })

  it('全选按钮选中所有 region', () => {
    render(<ShakePanel regions={regions} onSubmit={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('shake-select-all'))
    const checkbox2 = screen.getByTestId('shake-region-msg2:block:0:10') as HTMLInputElement
    expect(checkbox2.checked).toBe(true)
  })

  it('取消全选清除所有勾选', () => {
    render(<ShakePanel regions={regions} onSubmit={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('shake-select-all'))
    fireEvent.click(screen.getByTestId('shake-deselect-all'))
    const checkbox1 = screen.getByTestId('shake-region-msg1:toolResult:0') as HTMLInputElement
    expect(checkbox1.checked).toBe(false)
  })

  it('选当前及以下：勾选 messageIndex >= 1 的 region', () => {
    render(<ShakePanel regions={regions} onSubmit={vi.fn()} onClose={vi.fn()} fromIndex={1} />)
    fireEvent.click(screen.getByTestId('shake-select-from-here'))
    const checkbox1 = screen.getByTestId('shake-region-msg1:toolResult:0') as HTMLInputElement
    const checkbox2 = screen.getByTestId('shake-region-msg2:block:0:10') as HTMLInputElement
    expect(checkbox1.checked).toBe(false) // messageIndex=0 < 1
    expect(checkbox2.checked).toBe(true) // messageIndex=1 >= 1
  })

  it('提交时传入选中的 regionIds', () => {
    const onSubmit = vi.fn()
    render(<ShakePanel regions={regions} onSubmit={onSubmit} onClose={vi.fn()} />)
    // 默认已勾选第一个，直接提交
    fireEvent.click(screen.getByTestId('shake-submit'))
    expect(onSubmit).toHaveBeenCalledWith(['msg1:toolResult:0'])
  })

  it('取消按钮调用 onClose', () => {
    const onClose = vi.fn()
    render(<ShakePanel regions={regions} onSubmit={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('shake-cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('无 region 时显示空状态', () => {
    render(<ShakePanel regions={[]} onSubmit={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByTestId('shake-empty')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/web/components/ShakePanel.test.tsx`
Expected: FAIL — `Cannot find module './ShakePanel.js'`

- [ ] **Step 3: 实现 ShakePanel**

创建 `src/web/components/ShakePanel.tsx`：

```tsx
import { useState } from 'react'
import { css } from '@linaria/core'
import { X, Zap, CheckSquare, Square, ChevronDown } from 'lucide-react'
import type { ShakeRegionView } from '../types/index.js'

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
`

const panel = css`
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 600px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
`

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
`

const toolbar = css`
  display: flex;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
`

const toolbarBtn = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  &:hover {
    background: var(--bg-secondary);
  }
`

const regionList = css`
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
`

const regionRow = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  cursor: pointer;
  &:hover {
    background: var(--bg-secondary);
  }
`

const regionLabel = css`
  font-size: 13px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const tokenBadge = css`
  font-size: 11px;
  color: var(--text-secondary);
  font-family: ui-monospace, monospace;
  white-space: nowrap;
`

const previewText = css`
  font-size: 11px;
  color: var(--text-tertiary);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const footer = css`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
`

const primaryBtn = css`
  padding: 6px 16px;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  &:hover {
    opacity: 0.9;
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`

const secondaryBtn = css`
  padding: 6px 16px;
  background: transparent;
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
`

const emptyState = css`
  padding: 40px 16px;
  text-align: center;
  color: var(--text-secondary);
`

export function ShakePanel({
  regions,
  fromIndex,
  onSubmit,
  onClose,
}: {
  regions: ShakeRegionView[]
  fromIndex?: number
  onSubmit: (regionIds: string[]) => void
  onClose: () => void
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(regions.filter((r) => r.isAfterProtectWindow).map((r) => r.id)),
  )

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => setSelected(new Set(regions.map((r) => r.id)))
  const deselectAll = () => setSelected(new Set())
  const selectFromHere = () => {
    if (fromIndex === undefined) return
    setSelected(new Set(regions.filter((r) => r.messageIndex >= fromIndex).map((r) => r.id)))
  }

  const submit = () => {
    onSubmit([...selected])
  }

  return (
    <div className={overlay} onClick={onClose}>
      <div className={panel} onClick={(e) => e.stopPropagation()} data-testid="shake-panel">
        <div className={header}>
          <span>
            <Zap size={14} style={{ display: 'inline', marginRight: 6 }} />
            Shake — 机械裁剪重内容
          </span>
          <button onClick={onClose} type="button" style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>

        {regions.length === 0 ? (
          <div className={emptyState} data-testid="shake-empty">
            没有可 shake 的内容
          </div>
        ) : (
          <>
            <div className={toolbar}>
              <button className={toolbarBtn} onClick={selectAll} type="button" data-testid="shake-select-all">
                <CheckSquare size={12} /> 全选
              </button>
              {fromIndex !== undefined && (
                <button
                  className={toolbarBtn}
                  onClick={selectFromHere}
                  type="button"
                  data-testid="shake-select-from-here"
                >
                  <ChevronDown size={12} /> 选当前及以下
                </button>
              )}
              <button className={toolbarBtn} onClick={deselectAll} type="button" data-testid="shake-deselect-all">
                <Square size={12} /> 取消全选
              </button>
              <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)' }}>
                已选 {selected.size}/{regions.length} · 省 {[...selected].reduce((sum, id) => sum + (regions.find((r) => r.id === id)?.tokens ?? 0), 0)} token
              </span>
            </div>

            <div className={regionList}>
              {regions.map((r) => (
                <label
                  key={r.id}
                  className={regionRow}
                  data-testid={`shake-region-${r.id}`}
                  onClick={() => toggle(r.id)}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                    style={{ pointerEvents: 'none' }}
                  />
                  <span className={regionLabel}>
                    {r.kind === 'toolResult' ? '🔧' : '📄'} {r.label}
                  </span>
                  <span className={tokenBadge}>{r.tokens}t</span>
                  <span className={previewText} title={r.preview}>
                    {r.preview}
                  </span>
                </label>
              ))}
            </div>

            <div className={footer}>
              <button className={secondaryBtn} onClick={onClose} type="button" data-testid="shake-cancel">
                取消
              </button>
              <button
                className={primaryBtn}
                onClick={submit}
                type="button"
                disabled={selected.size === 0}
                data-testid="shake-submit"
              >
                提交 Shake
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run src/web/components/ShakePanel.test.tsx`
Expected: PASS

- [ ] **Step 5: lint + format**

Run: `npx biome check --write src/web/components/ShakePanel.tsx src/web/components/ShakePanel.test.tsx`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/web/components/ShakePanel.tsx src/web/components/ShakePanel.test.tsx
git commit -m "feat(web): ShakePanel component — checkbox list with select-all/from-here"
```

---

## Task 11: ChatView 接 Shake 按钮 + 面板

**Files:**
- Modify: `src/web/views/ChatView.tsx`
- Modify: `src/web/views/Chat.tsx`（加 `extraToolbar` prop 或复用 `topPanel`）

- [ ] **Step 1: 在 ChatSession 中加 shake 状态与处理**

修改 `src/web/views/ChatView.tsx`。

文件顶部 import 区加：

```typescript
import { Zap } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { ShakePanel } from '../components/ShakePanel.js'
import type { ShakeRegionView } from '../types/index.js'
```

在 `ChatSession` 函数组件内，`return` 前加状态：

```typescript
  // shake 面板状态
  const [shakeOpen, setShakeOpen] = useState(false)
  const [shakeRegions, setShakeRegions] = useState<ShakeRegionView[]>([])
  const shakeMutation = useMutation({
    mutationFn: async (regionIds: string[]) => {
      const result = await sessionAPI.shakeApply(sessionId, regionIds)
      return result
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', sessionId, 'messages'] })
      setShakeOpen(false)
    },
  })

  const handleShakeOpen = async () => {
    const result = await sessionAPI.shakePreview(sessionId)
    setShakeRegions(result.regions)
    setShakeOpen(true)
  }
```

在 `return` 的 JSX 中，`Chat` 组件的 `toolToggle` prop 之后，加 `topPanel` 的 shake 按钮（追加到已有的 topPanel 内）：

```typescript
        topPanel={
          <>
            {showInterruptBanner && !chat.isStreaming && (
              <div className={interruptBanner} data-testid="interrupt-banner">
                <span>连接已中断（服务可能已重启）</span>
                <button onClick={() => void handleResume()} type="button">
                  恢复对话
                </button>
                <button
                  onClick={() => {
                    setColdStartInterrupted(false)
                    chat.clearInterrupted()
                  }}
                  type="button"
                >
                  忽略
                </button>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, padding: '4px 12px' }}>
              <button
                onClick={() => void handleShakeOpen()}
                type="button"
                disabled={chat.isStreaming}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  background: 'transparent',
                  cursor: chat.isStreaming ? 'not-allowed' : 'pointer',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                }}
                data-testid="shake-button"
              >
                <Zap size={12} /> Shake
              </button>
              <SessionSummary sessionId={sessionId} />
            </div>
          </>
        }
```

在 `</Chat>` 后、`{chat.pendingSegmentBreak && (` 前加 ShakePanel：

```typescript
      {shakeOpen && (
        <ShakePanel
          regions={shakeRegions}
          fromIndex={Math.floor(messages.length / 2)}
          onSubmit={(regionIds) => shakeMutation.mutate(regionIds)}
          onClose={() => setShakeOpen(false)}
        />
      )}
```

注意：`fromIndex` 简化为一半位置——让"选当前及以下"有意义但不过于激进。实际使用中用户会在需要时手动调整。

- [ ] **Step 2: 验证类型检查通过**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: lint + format**

Run: `npx biome check --write src/web/views/ChatView.tsx`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/web/views/ChatView.tsx
git commit -m "feat(web): wire Shake button + ShakePanel into ChatView"
```

---

## Task 12: 全量回归验证

**Files:**
- 无修改，仅运行验证

- [ ] **Step 1: 全量类型检查**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 2: 全量 lint**

Run: `npx biome check`
Expected: 0 errors

- [ ] **Step 3: shake 相关全量测试**

Run: `npx vitest run src/session/shake.test.ts src/server/routes/session.test.ts src/web/components/ShakePanel.test.tsx`
Expected: ALL PASS

- [ ] **Step 4: 全量测试（确保无回归）**

Run: `npx vitest run`
Expected: ALL PASS (无回归)

- [ ] **Step 5: 最终 commit（如有 lint 自动修复产生的变更）**

```bash
git add -A
git diff --cached --quiet || git commit -m "chore: shake compaction — final lint pass"
```
