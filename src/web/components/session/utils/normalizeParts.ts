import type { Message } from '@shared/types/message.js'
import type { MessageRole } from '@shared/types/base.js'
import type { ToolResult } from '@shared/types/tool.js'

/** normalizeParts 产出的渲染块。 */
export type RenderBlock =
  | { type: 'text'; role: MessageRole; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'steering'; text: string }
  | {
      type: 'tool'
      id: string
      tool: string
      input: unknown
      status: 'running' | 'completed' | 'error' | 'paused'
      output?: ToolResult
    }

type ToolBlock = Extract<RenderBlock, { type: 'tool' }>

/** 把 message.content 归并为渲染块；按 id 合并 tool_call + tool_result。 */
export function normalizeParts(message: Message): RenderBlock[] {
  const blocks: RenderBlock[] = []
  const toolIndex = new Map<string, number>()

  for (const part of message.content) {
    switch (part._tag) {
      case 'text':
        blocks.push({ type: 'text', role: message.role, text: part.text })
        break
      case 'thinking':
        blocks.push({ type: 'thinking', text: part.text })
        break
      case 'steering':
        blocks.push({ type: 'steering', text: part.text })
        break
      case 'tool_call': {
        const tb: ToolBlock = {
          type: 'tool',
          id: part.id,
          tool: part.tool,
          input: part.input,
          status: 'running',
        }
        toolIndex.set(part.id, blocks.length)
        blocks.push(tb)
        break
      }
      case 'tool_result': {
        const status = resultStatus(part.output)
        const idx = toolIndex.get(part.id)
        if (idx !== undefined) {
          const tb = blocks[idx] as ToolBlock
          tb.status = status
          tb.output = part.output
          if (!tb.tool) tb.tool = part.tool || 'tool'
        } else {
          blocks.push({
            type: 'tool',
            id: part.id,
            tool: part.tool || 'tool',
            input: null,
            status,
            output: part.output,
          })
        }
        break
      }
    }
  }
  return blocks
}

function resultStatus(output: ToolResult): 'completed' | 'error' | 'paused' {
  switch (output._tag) {
    case 'success':
    case 'truncated':
      return 'completed'
    case 'error':
      return 'error'
    case 'permission_required':
      return 'paused'
  }
}
