import { isLLMError, llmError, reasonMessage } from '../../schema/errors.js'
import type {
  StreamEvent,
  ToolCallEvent,
  ToolInputDelta,
  ToolInputEnd,
  ToolInputStart,
} from '../../schema/events.js'
import type { ToolCallID } from '../../schema/ids.js'

type PendingTool = {
  id: ToolCallID
  name: string
  input: string
  started: boolean
}

type ToolStreamState = Record<number, PendingTool>

type DeltaInput = {
  index: number
  id?: string
  name?: string
  /** Fragment of the JSON arguments string. */
  argumentsDelta?: string
}

type AppendOutcome = {
  state: ToolStreamState
  events: StreamEvent[]
}

const empty = (): ToolStreamState => ({})

/**
 * Append a tool-call delta.
 *
 * Identity（id/name）可能在后续 delta 才到达：部分兼容 provider 的首个
 * tool_calls 片段只带 index 与 arguments，id/name 缺席。此前对无 id/name 的
 * delta 整体丢弃——领先的 arguments 片段静默蒸发，工具入参被截断/损坏
 * （JSON 解析失败或语义漂移的「执行了错误参数」）。正确语义：
 *  1. 身份未齐时创建占位条目，片段只累积、不发事件（无 id 无法发事件）；
 *  2. 身份到达时补发 tool-input-start + 已缓冲的 tool-input-delta，再追加
 *     当前片段——事件顺序与参数内容完整；
 *  3. 身份始终缺失的条目在 finishAll 静默跳过（无法映射为工具调用，
 *     与旧的「整体丢弃」等价——空 id 的 tool call 会在下一轮触发
 *     invalid tool_call_id）。
 */
const appendOrStart = (state: ToolStreamState, delta: DeltaInput): AppendOutcome => {
  const current = state[delta.index]
  const events: StreamEvent[] = []
  let next: PendingTool
  if (current === undefined) {
    next = { id: delta.id ?? '', name: delta.name ?? '', input: '', started: false }
  } else {
    next = { ...current }
  }
  // 回填迟到的身份字段（已就位的字段不受后续 delta 的空值影响）
  if (next.id === '' && delta.id) next.id = delta.id
  if (next.name === '' && delta.name) next.name = delta.name
  const identityReady = next.id !== '' && next.name !== ''
  if (identityReady && !next.started) {
    const start: ToolInputStart = { type: 'tool-input-start', id: next.id, name: next.name }
    events.push(start)
    next.started = true
    // 身份到达前已缓冲的片段按到达顺序补发
    if (next.input.length > 0) {
      const buffered: ToolInputDelta = {
        type: 'tool-input-delta',
        id: next.id,
        name: next.name,
        text: next.input,
      }
      events.push(buffered)
    }
  }
  if (delta.argumentsDelta !== undefined && delta.argumentsDelta.length > 0) {
    next.input += delta.argumentsDelta
    if (next.started) {
      const d: ToolInputDelta = {
        type: 'tool-input-delta',
        id: next.id,
        name: next.name,
        text: delta.argumentsDelta,
      }
      events.push(d)
    }
  }
  return { state: { ...state, [delta.index]: next }, events }
}

type FinishedTool = { id: ToolCallID; name: string; input: unknown }

type FinishAllOutcome = {
  state: ToolStreamState
  events: StreamEvent[]
  tools: FinishedTool[]
}

/** Parse a raw JSON arguments string; empty string becomes `{}`. */
const parseToolInput = (raw: string): unknown => {
  const source = raw.length === 0 ? '{}' : raw
  try {
    return JSON.parse(source)
  } catch {
    throw llmError('ProviderShared', 'stream', {
      _tag: 'InvalidProviderOutput',
      message: `Invalid JSON tool arguments: ${source}`,
      raw: source,
    })
  }
}

/**
 * Finalize all pending tool calls (OpenAI Chat style — no per-tool stop event).
 * Emits `tool-input-end` + parsed `tool-call` for each, and clears state.
 */
const finishAll = (state: ToolStreamState): FinishAllOutcome => {
  const events: StreamEvent[] = []
  const tools: FinishedTool[] = []
  for (const key of Object.keys(state)) {
    const tool = state[Number(key)]
    if (tool === undefined) continue
    // 身份始终缺失的占位条目（appendOrStart 缓冲后 id/name 从未到达）无法
    // 映射为工具调用——静默跳过，与旧的「整体丢弃」口径一致。
    if (!tool.started) continue
    const end: ToolInputEnd = { type: 'tool-input-end', id: tool.id, name: tool.name }
    events.push(end)
    // 解析失败不抛错：模型可能输出不完整 JSON（流被截断/提前结束）。
    // 标记 _parseError + _raw 让流完整结束，由 agent loop 把错误反馈给模型重试，
    // 而非让整个会话崩溃。对齐 oh-my-pi 的 __parseError 容错（agent-loop.ts:1741）。
    let input: unknown
    try {
      input = parseToolInput(tool.input)
    } catch (e) {
      // parseToolInput 抛的是 llmError（普通对象，非 Error 实例），直接 String(e)
      // 会退化成 "[object Object]"。按错误类型提取可读消息。
      input = {
        _parseError: isLLMError(e)
          ? reasonMessage(e.reason)
          : e instanceof Error
            ? e.message
            : String(e),
        _raw: tool.input,
      }
    }
    tools.push({ id: tool.id, name: tool.name, input })
    const call: ToolCallEvent = { type: 'tool-call', id: tool.id, name: tool.name, input }
    events.push(call)
  }
  return { state: {}, events, tools }
}

export type { AppendOutcome, DeltaInput, FinishAllOutcome, FinishedTool, ToolStreamState }
export { appendOrStart, empty, finishAll, parseToolInput }
