import type { MessageRole } from '@shared/types/base.js'
import type { Message, MessageContent } from '@shared/types/message.js'
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

/**
 * 把独立的 tool 角色消息（仅含 tool_result）合并回前面含对应 tool_call 的 assistant 消息。
 *
 * 持久化层把同轮的 assistant(tool_call) 与 tool(tool_result) 存成两条独立 Message，
 * 而 normalizeParts 只在单条 Message 内按 id 配对。历史重载时若不合并：assistant 的
 * tool_call 找不到 result 会永远显示 "running"，tool 消息则渲染成孤立的 result 卡，
 * 每个历史工具调用都会出现两张卡。实时流式消息已由 useChat reducer 在同一条
 * assistant 内配对，对本函数是 no-op。不修改入参数组（浅拷贝每条消息的 content）。
 */
export function mergeToolMessages(messages: Message[]): Message[] {
  if (messages.length === 0) return messages
  const out: Message[] = messages.map((m) => ({ ...m, content: [...m.content] }))
  // tool_call id → out 中 assistant 消息索引
  const callIndex = new Map<string, number>()
  for (let i = 0; i < out.length; i++) {
    const m = out[i]
    if (m.role !== 'assistant') continue
    for (const p of m.content) {
      if (p._tag === 'tool_call' && p.id) callIndex.set(p.id, i)
    }
  }
  const drop = new Set<number>()
  for (let i = 0; i < out.length; i++) {
    const m = out[i]
    if (m.role !== 'tool') continue
    const found = m.content.find(
      (p): p is Extract<MessageContent, { _tag: 'tool_result' }> => p._tag === 'tool_result',
    )
    if (!found) continue
    const ai = callIndex.get(found.id)
    if (ai === undefined) continue // 无对应 assistant tool_call：保留，由 normalizeParts 兜底渲染
    const assistant = out[ai]
    if (assistant === undefined) continue
    // 仅当 assistant 还没含该 result 时并入，避免重复
    const has = assistant.content.some((p) => p._tag === 'tool_result' && p.id === found.id)
    if (!has) assistant.content.push(found)
    drop.add(i)
  }
  return out.filter((_, i) => !drop.has(i))
}
