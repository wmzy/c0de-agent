// Advisor 输入渲染：DB 全量消息 → 增量文本（只含上次审查之后的新消息）。
//
// 增量切分的动机同 omp delta-split 的 prompt-cache 思路：advisor 每个更新
// 只需要「新发生了什么」，按消息分块（每条一个 ### Session update 头）让
// 输入结构稳定追加而非整体重排。最小版是单发 LLM（无多消息切分），但保留
// 「每条消息单独成块」的结构，未来升级为多消息 advisor transcript 时块边界
// 即消息边界，不用重写渲染。
//
// 全部文本先经 redactSecretText 再进入任何拼接：advisor 输入会流向用户配置
// 的任意 provider（审查模型可能与主模型不同家），与记忆管线同一条铁律——
// 凭证一旦原样送出，之后每一次审查都会继续泄漏。

import type { Message, MessageContent } from '../shared/types/message.js'
import { redactSecretText } from '../shared/utils/secret-redact.js'
import { headChars } from '../shared/utils/string.js'

/** 常规文本 part 的渲染上限（字符）。审查只需要「发生了什么」，不是全文。 */
const MAX_TEXT_CHARS = 4000
/** thinking 摘要更短：意图信号有用，长推理链无增量价值。 */
const MAX_THINKING_CHARS = 1500
/** 工具参数摘要 / 结果首行的截断上限。 */
const MAX_TOOL_SNIPPET_CHARS = 200
/** 会话 seen 计数表上限：长驻 server 进程防无界增长。超限整体清空——
 *  后果只是受影响会话的下一趟把全量消息重看一遍（一次性、有界）。 */
const MAX_TRACKED_SESSIONS = 512

/** 截断标记后缀。 */
const TRUNCATED_SUFFIX = '…[truncated]'

/** 截断 + 标记后缀：共享 truncateHead 的本地薄壳变体——后缀不计入上限
 *  （truncateHead 把省略号计入上限），切片经 headChars 内收不拆代理对。 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${headChars(text, max)}${TRUNCATED_SUFFIX}`
}

/** 结果首行：工具输出动辄百行，advisor 只需要首行结论。 */
function firstLine(output: string): string {
  const trimmed = output.trim()
  const line = trimmed.split('\n')[0] ?? ''
  return line
}

function renderToolCall(part: Extract<MessageContent, { _tag: 'tool_call' }>): string {
  let args: string
  try {
    args = JSON.stringify(part.input) ?? ''
  } catch {
    // 参数含循环引用等不可序列化值：摘要留空，不因渲染炸掉审查。
    args = ''
  }
  return `tool_call \`${part.tool}\`(${truncate(redactSecretText(args), MAX_TOOL_SNIPPET_CHARS)})`
}

function renderToolResult(part: Extract<MessageContent, { _tag: 'tool_result' }>): string {
  const out = part.output
  // permission_required 变体只有 reason（无 output）：渲染等待原因，其余取首行。
  const text =
    out._tag === 'error'
      ? out.error
      : out._tag === 'permission_required'
        ? out.reason
        : (out.output ?? '')
  const flag =
    out._tag === 'error'
      ? ' [error]'
      : out._tag === 'permission_required'
        ? ' [permission_required]'
        : ''
  const line = truncate(redactSecretText(firstLine(text)), MAX_TOOL_SNIPPET_CHARS)
  return `tool_result \`${part.tool}\`${flag}: ${line}`
}

function renderContentPart(part: MessageContent): string | null {
  switch (part._tag) {
    case 'text':
      return truncate(redactSecretText(part.text), MAX_TEXT_CHARS)
    case 'thinking':
      return `thinking: ${truncate(redactSecretText(part.text), MAX_THINKING_CHARS)}`
    case 'steering':
      return `steering: ${truncate(redactSecretText(part.text), MAX_TEXT_CHARS)}`
    case 'tool_call':
      return renderToolCall(part)
    case 'tool_result':
      return renderToolResult(part)
    case 'image':
      // 图像无法进入纯文本审查输入；标注存在即可（说明 agent 看过图）。
      return `image ${part.mediaType} (bytes omitted)`
    default:
      return null
  }
}

/** 渲染单条消息为独立块（导出供测试）。块 = `### Session update` 头 + 角色
 *  + 各 content part 的紧凑 markdown。无可渲染 part 时返回 null。 */
export function renderMessageBlock(message: Message): string | null {
  const parts = message.content.map(renderContentPart).filter((p): p is string => p !== null)
  if (parts.length === 0) return null
  return `### Session update (${message.role})\n\n${parts.join('\n\n')}`
}

export interface AdvisorDeltaRenderer {
  /** 渲染该会话自上次调用以来的新增消息（按 seen 前缀 diff）。无新增或
   *  消息列表为空返回 null（调用方跳过本趟审查）。 */
  render: (sessionId: string, messages: Message[]) => string | null
}

/** 创建有状态增量渲染器：per-session 记已见消息数，只渲染新增前缀之后
 *  的消息。消息数回缩（/clear、压缩归档）视为重置，从 0 重看。 */
export function createDeltaRenderer(): AdvisorDeltaRenderer {
  const seenCounts = new Map<string, number>()
  return {
    render(sessionId, messages) {
      if (messages.length === 0) return null
      const seen = seenCounts.get(sessionId) ?? 0
      // 回缩 = 会话被重写（clear/压缩）：重置计数重看全量，避免「永远
      // 认为一切都看过了」导致增量恒为空。
      const start = messages.length < seen ? 0 : seen
      const blocks: string[] = []
      for (let i = start; i < messages.length; i++) {
        const block = renderMessageBlock(messages[i] as Message)
        if (block) blocks.push(block)
      }
      seenCounts.set(sessionId, messages.length)
      if (seenCounts.size > MAX_TRACKED_SESSIONS) seenCounts.clear()
      return blocks.length > 0 ? blocks.join('\n\n') : null
    },
  }
}
