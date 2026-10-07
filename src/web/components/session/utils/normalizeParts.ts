import type { MessageRole } from '@shared/types/base.js'
import type { Message, MessageContent } from '@shared/types/message.js'
import type { ToolResult } from '@shared/types/tool.js'

/** normalizeParts 产出的渲染块。 */
export type RenderBlock =
  | { type: 'text'; role: MessageRole; text: string; partIndex: number }
  | { type: 'thinking'; text: string; partIndex: number }
  | { type: 'steering'; text: string; partIndex: number }
  | { type: 'image'; mediaType: string; data: string; partIndex: number }
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

  message.content.forEach((part, partIndex) => {
    switch (part._tag) {
      case 'text':
        blocks.push({ type: 'text', role: message.role, text: part.text, partIndex })
        break
      case 'thinking':
        blocks.push({ type: 'thinking', text: part.text, partIndex })
        break
      case 'steering':
        blocks.push({ type: 'steering', text: part.text, partIndex })
        break
      // 图片此前被整个丢掉：消息里只剩 image part 时渲染出一整行空白（滞留条显示
      // 「(空消息)」），图文消息则只见文字——用户自己刚发出的图片在会话里没有痕迹。
      case 'image':
        blocks.push({
          type: 'image',
          mediaType: part.mediaType,
          data: part.data,
          partIndex,
        })
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
  })
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
    if (m?.role !== 'assistant') continue
    for (const p of m.content) {
      if (p._tag === 'tool_call' && p.id) callIndex.set(p.id, i)
    }
  }
  const drop = new Set<number>()
  for (let i = 0; i < out.length; i++) {
    const m = out[i]
    if (m?.role !== 'tool') continue
    // 逐条 tool_result 合并（此前 find 只取首个）：并行工具轮次的多条结果
    // 存于同一条 tool 消息时，未合并的其余结果会随整条消息 drop 静默丢失；
    // 首个 result 无对应 call 时也会跳过整条消息、连累后续可合并的结果。
    const remaining: MessageContent[] = []
    for (const p of m.content) {
      if (p._tag !== 'tool_result') {
        remaining.push(p)
        continue
      }
      const ai = callIndex.get(p.id)
      const assistant = ai === undefined ? undefined : out[ai]
      if (!assistant) {
        remaining.push(p) // 无对应 assistant tool_call：保留，由 normalizeParts 兜底渲染
        continue
      }
      const has = assistant.content.some((q) => q._tag === 'tool_result' && q.id === p.id)
      if (has) continue // assistant 已含该 result（实时 reducer 已并入）——丢弃重复
      assistant.content.push(p)
    }
    if (remaining.length === m.content.length) continue // 无任何可合并项：原样保留
    if (remaining.length === 0) drop.add(i)
    else m.content = remaining
  }
  return out.filter((_, i) => !drop.has(i))
}

/** 用户消息中服务端注入的 @agent 派发指令前缀（chat 路由在落库前写入文本）。 */
const SUBAGENT_MENTION_PREFIX_RE = /^\[User requested subagent\(s\): [^\]]*\]\n\n/

/**
 * 消息身份签名：把「本地乐观副本」与「服务端持久化副本」配对用。
 * 两侧 id 必然不同（客户端 generateId vs 服务端 appendMessage），只能按内容比对：
 *  - text / steering：文本本身（空文本部分忽略——纯图片消息的服务端副本没有空
 *    text part，客户端乐观副本有）；
 *  - tool_call：调用 id（provider 生成、两侧一致，入参也一致故不入签名）；
 *  - image：mediaType + 数据长度（完整 base64 比对在每帧渲染时太贵；同类型同
 *    长度的不同图片才会误配，概率可忽略）；
 *  - thinking：忽略（不落库，乐观副本独有）；
 *  - tool_result：忽略（持久化侧是独立 tool 消息，由 mergeToolMessages 合并回
 *    assistant；乐观侧已就地配对）。
 * 用户文本先剥离服务端注入的 @agent 指令前缀（同一句输入两侧文本不同）。
 */
function messageSignature(message: Message): string {
  const parts: string[] = []
  for (const part of message.content) {
    switch (part._tag) {
      case 'text': {
        const text =
          message.role === 'user' ? part.text.replace(SUBAGENT_MENTION_PREFIX_RE, '') : part.text
        if (text) parts.push(`t:${text}`)
        break
      }
      case 'steering':
        if (part.text) parts.push(`s:${part.text}`)
        break
      case 'tool_call':
        parts.push(`c:${part.id}`)
        break
      case 'image':
        parts.push(`i:${part.mediaType}:${part.data.length}`)
        break
      case 'thinking':
      case 'tool_result':
        break
    }
  }
  return `${message.role}\u0000${parts.join('\u0001')}`
}

/**
 * 合并「服务端历史」与「本地乐观消息」为渲染列表：服务端历史是唯一事实源，
 * 乐观消息一旦在历史中已有持久化条目即丢弃本地副本。
 *
 * 乐观副本与服务端副本 id 不同（客户端 generateId vs 服务端 appendMessage），
 * 直接拼接会在任何历史重取后重复渲染整轮对话：窗口聚焦
 * （refetchOnWindowFocus）、shake 应用、附着结束刷新都会重取 /messages，而
 * useChat 的乐观消息在页面存活期间一直保留——同一句用户输入与同一条回复
 * 各出现两次（时间线上重复行、调用详情错配）。
 *
 * 配对按内容签名 + 计数（相同文本重复发送两次时按数量逐一消费，不吞掉尚未
 * 落库的那条）；历史中没有对应条目的乐观消息原样保留——中断的 run 半截回复
 * 不写库（loop 在轮次结束时才持久化 assistant），清空它会让用户已看到的
 * 内容凭空消失。
 */
export function mergeSessionMessages(history: Message[], optimistic: Message[]): Message[] {
  if (optimistic.length === 0) return mergeToolMessages(history)
  const persisted = new Map<string, number>()
  for (const m of history) {
    const key = messageSignature(m)
    persisted.set(key, (persisted.get(key) ?? 0) + 1)
  }
  const pending: Message[] = []
  for (const m of optimistic) {
    const key = messageSignature(m)
    const left = persisted.get(key) ?? 0
    if (left > 0) {
      persisted.set(key, left - 1)
      continue
    }
    pending.push(m)
  }
  return mergeToolMessages([...history, ...pending])
}
