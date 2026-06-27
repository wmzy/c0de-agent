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
const appendOrStart = (
  state: ToolStreamState,
  delta: DeltaInput,
  missingToolMessage: string,
): AppendOutcome => {
  const current = state[delta.index]
  const events: StreamEvent[] = []
  let next: PendingTool
  if (current === undefined) {
    const id = delta.id
    const name = delta.name
    if (id === undefined || name === undefined) {
      throw llmError('ProviderShared', 'stream', {
        _tag: 'InvalidProviderOutput',
        message: missingToolMessage,
      })
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
    const input = parseToolInput(tool.input)
    tools.push({ id: tool.id, name: tool.name, input })
    const call: ToolCallEvent = { type: 'tool-call', id: tool.id, name: tool.name, input }
    events.push(call)
  }
  return { state: {}, events, tools }
}

export type { AppendOutcome, DeltaInput, FinishAllOutcome, FinishedTool, ToolStreamState }
export { appendOrStart, empty, finishAll, parseToolInput }
