import { llmError } from '../../schema/errors.js'
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
 * Append a tool-call delta. If the index is new, emit a `tool-input-start`
 * (using the delta's id/name if present, else synthesized). Then emit a
 * `tool-input-delta` when an argument fragment is present.
 */
const appendOrStart = (state: ToolStreamState, delta: DeltaInput): AppendOutcome => {
  const current = state[delta.index]
  const events: StreamEvent[] = []
  let next: PendingTool
  if (current === undefined) {
    const id = delta.id
    const name = delta.name
    // 无效 id/name（缺失或空字符串）：丢弃该 delta 而非抛错。部分兼容
    // provider 把 tool call 的 arguments 流式片段拆成多个独立 delta，每片
    // id/name 为空。接受空值会产生空 id 的 tool call，导致下一轮
    // invalid tool_call_id；抛错则让整个流崩溃。跳过最稳妥。
    if (!id || !name) {
      return { state, events }
    }
    next = { id, name, input: '', started: false }
    const start: ToolInputStart = { type: 'tool-input-start', id, name }
    events.push(start)
    next.started = true
  } else {
    next = { ...current }
  }
  if (delta.argumentsDelta !== undefined && delta.argumentsDelta.length > 0) {
    next.input += delta.argumentsDelta
    const d: ToolInputDelta = {
      type: 'tool-input-delta',
      id: next.id,
      name: next.name,
      text: delta.argumentsDelta,
    }
    events.push(d)
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
    const end: ToolInputEnd = { type: 'tool-input-end', id: tool.id, name: tool.name }
    events.push(end)
    // 解析失败不抛错：模型可能输出不完整 JSON（流被截断/提前结束）。
    // 标记 _parseError + _raw 让流完整结束，由 agent loop 把错误反馈给模型重试，
    // 而非让整个会话崩溃。对齐 oh-my-pi 的 __parseError 容错（agent-loop.ts:1741）。
    let input: unknown
    try {
      input = parseToolInput(tool.input)
    } catch (e) {
      input = {
        _parseError: e instanceof Error ? e.message : String(e),
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
