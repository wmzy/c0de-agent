import { estimateTokens } from '../llm/token.js'
import type { MessageContent } from '../shared/types/message.js'

export { estimateTokens }

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

export { estimateMessageTokens }
