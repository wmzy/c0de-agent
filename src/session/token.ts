import { estimateTokens } from '../llm/token.js'
import type { MessageContent } from '../shared/types/message.js'

export { estimateTokens }

/** 单张图片的固定 token 估算。
 *  provider 图片计费按像素维度而非字节（OpenAI high-detail 1024×1024 ≈ 1105），
 *  message 内容只携带 base64 数据、无尺寸信息——按字节长度估算会系统性偏差
 *  数百倍（1MB 截图 ≈ 34 万「token」）。固定典型值保数量级正确。 */
const IMAGE_PART_TOKEN_ESTIMATE = 1100

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
      case 'image':
        // 图片轮次真实开销约千级 token——此前无 case 恒计 0，
        // 预算护栏/压缩窗口把图片消息当免费。
        total += IMAGE_PART_TOKEN_ESTIMATE
        break
    }
  }
  return total
}

export { estimateMessageTokens }
