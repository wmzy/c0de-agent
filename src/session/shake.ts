import type { Message, MessageContent } from '../shared/types/message.js'
import type { ToolResult } from '../shared/types/tool.js'
import { estimateTokens } from './token.js'

/** Rough token cost of a placeholder line; used only for the savings gate. */
const PLACEHOLDER_TOKEN_ESTIMATE = 16

/** 识别顶层 XML 元素（小写 tag，保守策略）。 */
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
      // Only recognize top-level XML (no leading whitespace)
      if (line.length === trimmedStart.length) {
        const openingMatch = OPENING_XML.exec(trimmedStart)
        if (openingMatch) {
          const tagName = openingMatch[1]
          if (tagName) {
            if (tagStack.length === 0) xmlStart = lineStart
            tagStack.push(tagName)
          }
        } else {
          const closingMatch = CLOSING_XML.exec(trimmedStart)
          if (
            closingMatch &&
            tagStack.length > 0 &&
            tagStack[tagStack.length - 1] === closingMatch[1]
          ) {
            tagStack.pop()
            if (tagStack.length === 0 && xmlStart >= 0) {
              ranges.push({ start: xmlStart, end: lineEnd })
              xmlStart = -1
            }
          }
        }
      }
    }

    lineStart = i + 1
  }

  return mergeRanges(ranges)
}

/** 按 start 升序，丢弃与已保留范围重叠的（嵌套取最外层）。 */
function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{
  start: number
  end: number
}> {
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

/** 单条消息的 token 估算（优先用缓存的 tokenCount）。 */
function messageTokens(m: Message): number {
  if (m.tokenCount > 0) return m.tokenCount
  let total = 0
  for (const part of m.content) {
    switch (part._tag) {
      case 'text':
      case 'thinking':
      case 'steering':
        total += estimateTokens(part.text)
        break
      case 'tool_call':
        total += estimateTokens(JSON.stringify(part.input))
        break
      case 'tool_result':
        total += estimateTokens(JSON.stringify(part.output))
        break
    }
  }
  return total
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
    if (!isAfterProtectWindow) continue

    for (let partIndex = 0; partIndex < msg.content.length; partIndex++) {
      const part = msg.content[partIndex]!

      // tool_result 区域
      if (part._tag === 'tool_result') {
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
        continue
      }

      // text/thinking block 区域
      if (part._tag === 'text' || part._tag === 'thinking') {
        for (const range of scanTextForBlockRanges(part.text)) {
          const slice = part.text.slice(range.start, range.end)
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

/** 为区域生成占位符文本。 */
function placeholderFor(region: ShakeRegion): string {
  if (region.kind === 'toolResult') {
    return `[shaken: ${region.label}, ${region.tokens} tokens]`
  }
  return '[shaken]'
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

    // 深拷贝 content（保证不修改原对象）
    const newContent = structuredClone(msg.content) as MessageContent[]
    const now = Date.now()

    // toolResult 区域：替换 output 文本
    for (const region of msgRegions) {
      if (region.kind !== 'toolResult') continue
      const part = newContent[region.partIndex]
      if (!part || part._tag !== 'tool_result') continue
      const placeholder = placeholderFor(region)
      if (part.output._tag === 'success') {
        part.output = { ...part.output, output: placeholder, shakenAt: now }
      } else if (part.output._tag === 'error') {
        part.output = { ...part.output, error: placeholder, shakenAt: now }
      } else if (part.output._tag === 'truncated') {
        part.output = { ...part.output, output: placeholder, shakenAt: now }
      }
    }

    // block 区域：按 partIndex 分组，同一 text 内按 start 降序 splice
    const blockByPart = new Map<number, Extract<ShakeRegion, { kind: 'block' }>[]>()
    for (const region of msgRegions) {
      if (region.kind !== 'block') continue
      const list = blockByPart.get(region.partIndex) ?? []
      list.push(region)
      blockByPart.set(region.partIndex, list)
    }
    for (const [partIndex, blockRegions] of blockByPart) {
      const part = newContent[partIndex]
      if (!part || (part._tag !== 'text' && part._tag !== 'thinking')) continue
      const sorted = [...blockRegions].sort((a, b) => b.start - a.start)
      let text = part.text
      for (const br of sorted) {
        text = text.slice(0, br.start) + placeholderFor(br) + text.slice(br.end)
      }
      part.text = text
    }

    return { ...msg, content: newContent }
  })
}

/** 区域转 API 视图。protectWindow 窗口内的标记 isAfterProtectWindow=false。 */
export function toRegionViews(
  regions: ShakeRegion[],
  config: ShakeConfig,
  messages: Message[],
): ShakeRegionView[] {
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
