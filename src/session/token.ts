import type { MessageContent } from '../shared/types/message.js'

/**
 * CJK-aware token estimate.
 * Chinese/CJK characters ≈ 2 tokens each (denser encoding).
 * Other characters ≈ 4 chars/token (standard heuristic).
 */
const estimateTokens = (text: string): number => {
  if (text.length === 0) return 0
  const cjkCount = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0
  const otherCount = text.length - cjkCount
  return Math.ceil(cjkCount * 2 + otherCount / 4)
}

/** Sum token estimates across all parts of a message's content array. */
const estimateMessageTokens = (content: MessageContent[]): number => {
  let total = 0
  for (const part of content) {
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

export { estimateMessageTokens, estimateTokens }
