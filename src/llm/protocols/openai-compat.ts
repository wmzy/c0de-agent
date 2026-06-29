import { llmError } from '../schema/errors.js'
import type { StreamEvent } from '../schema/events.js'
import type { FinishReason, ProviderMetadata } from '../schema/ids.js'
import type { ContentPart, InternalRequest, Message, ToolDefinition } from '../schema/messages.js'
import type { GenerationOptions, RouteDefaults } from '../schema/options.js'
import {
  type LifecycleState,
  finish as lifecycleFinish,
  initial as lifecycleInitial,
  reasoningDelta,
  textDelta,
} from './utils/lifecycle.js'
import {
  appendOrStart,
  empty as emptyTools,
  finishAll,
  type ToolStreamState,
} from './utils/tool-stream.js'

type OpenAIChatRole = 'system' | 'user' | 'assistant' | 'tool'

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type OpenAIMessage = {
  role: OpenAIChatRole
  content: string | OpenAIContentPart[]
  tool_call_id?: string
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
}

type OpenAITool = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

type OpenAIBody = {
  model: string
  messages: OpenAIMessage[]
  tools?: OpenAITool[]
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
  stream: true
  max_tokens?: number
  temperature?: number
  top_p?: number
  stream_options?: { include_usage: boolean }
}

/** Merge system parts into a single system string (OpenAI Chat has one system slot). */
const joinSystem = (request: InternalRequest): string =>
  request.system.map((p) => p.text).join('\n\n')

const toOpenAIContent = (part: ContentPart): OpenAIContentPart => {
  if (part.type === 'text') return { type: 'text', text: part.text }
  return { type: 'text', text: '' }
}

const messageToOpenAI = (msg: Message): OpenAIMessage => {
  if (msg.role === 'system') {
    return {
      role: 'system',
      content: msg.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
    }
  }
  if (msg.role === 'tool') {
    const toolPart = msg.content.find((p) => p.type === 'tool-result')
    if (toolPart && toolPart.type === 'tool-result') {
      const text =
        toolPart.result.type === 'text'
          ? String(toolPart.result.value)
          : JSON.stringify(toolPart.result.value)
      return { role: 'tool', content: text, tool_call_id: toolPart.id }
    }
    return { role: 'tool', content: '' }
  }
  const textParts = msg.content.filter((p) => p.type === 'text')
  const toolCalls = msg.content.filter(
    (p): p is Extract<ContentPart, { type: 'tool-call' }> => p.type === 'tool-call',
  )
  const content: OpenAIContentPart[] | string =
    msg.role === 'user'
      ? textParts.map(toOpenAIContent)
      : textParts.map((p) => (p.type === 'text' ? p.text : '')).join('')
  const message: OpenAIMessage = {
    role: msg.role as OpenAIChatRole,
    content,
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
    }))
  }
  return message
}

const toolToOpenAI = (tool: ToolDefinition): OpenAITool => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  },
})

/** Build an OpenAI Chat Completions request body from an InternalRequest. */
const bodyFrom = (request: InternalRequest): OpenAIBody => {
  const systemText = joinSystem(request)
  const messages: OpenAIMessage[] = []
  if (systemText.length > 0) {
    messages.push({ role: 'system', content: systemText })
  }
  for (const msg of request.messages) {
    messages.push(messageToOpenAI(msg))
  }
  const generation: GenerationOptions | undefined = request.generation
  const body: OpenAIBody = {
    model: request.model.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (request.tools.length > 0) {
    body.tools = request.tools.map(toolToOpenAI)
    if (request.toolChoice !== undefined) {
      body.tool_choice =
        request.toolChoice.type === 'tool'
          ? { type: 'function', function: { name: request.toolChoice.name } }
          : request.toolChoice.type
    }
  }
  if (generation?.maxTokens !== undefined) body.max_tokens = generation.maxTokens
  if (generation?.temperature !== undefined) body.temperature = generation.temperature
  if (generation?.topP !== undefined) body.top_p = generation.topP
  return body
}

type OpenAIDelta = {
  content?: string
  reasoning_content?: string
  reasoning?: string
  tool_calls?: {
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }[]
}

type OpenAIChoice = {
  delta?: OpenAIDelta
  finish_reason?: string | null
}

type OpenAIStreamChunk = {
  choices?: OpenAIChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

const mapFinishReason = (raw: string | null | undefined): FinishReason => {
  switch (raw) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls'
    case 'content_filter':
      return 'content-filter'
    default:
      return 'unknown'
  }
}

type StepState = {
  lifecycle: LifecycleState
  tools: ToolStreamState
  /** Finish reason seen but not yet finalized (waiting for trailing usage chunk). */
  pendingFinish: FinishReason | null
}

const initialStepState = (): StepState => ({
  lifecycle: lifecycleInitial(),
  tools: emptyTools(),
  pendingFinish: null,
})

/** Map an OpenAI usage object to the internal Usage fields. */
const mapUsage = (raw: NonNullable<OpenAIStreamChunk['usage']>) => ({
  inputTokens: raw.prompt_tokens,
  outputTokens: raw.completion_tokens,
  cacheReadInputTokens: raw.prompt_tokens_details?.cached_tokens,
  totalTokens: raw.total_tokens,
  providerMetadata: { openai: raw } as ProviderMetadata,
})

/** Finalize the stream: close open blocks, emit step-finish + finish. */
const finalize = (
  lifecycle: LifecycleState,
  events: StreamEvent[],
  reason: FinishReason,
  usage?: ReturnType<typeof mapUsage>,
): LifecycleState => lifecycleFinish(lifecycle, events, { reason, usage }).state

/**
 * Fold one OpenAI stream chunk into (next state, events).
 *
 * OpenAI sends finish_reason in the penultimate chunk and usage in a SEPARATE
 * trailing chunk (choices: []) when stream_options.include_usage is set. So we
 * defer finalization: on finish_reason without usage we stash the reason; the
 * trailing usage chunk triggers the finish. `done` is only true once finalized.
 */
const step = (
  state: StepState,
  chunk: OpenAIStreamChunk,
): { state: StepState; events: StreamEvent[]; done: boolean } => {
  const events: StreamEvent[] = []
  let lifecycle = state.lifecycle
  let tools = state.tools
  let pendingFinish = state.pendingFinish
  let done = false

  const choice = chunk.choices?.[0]
  if (choice !== undefined && choice.delta !== undefined) {
    const delta = choice.delta
    if (delta.content !== undefined && delta.content.length > 0) {
      lifecycle = textDelta(lifecycle, events, 'text-main', delta.content).state
    }
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (reasoning !== undefined && reasoning.length > 0) {
      lifecycle = reasoningDelta(lifecycle, events, 'reasoning-main', reasoning).state
    }
    if (delta.tool_calls !== undefined) {
      for (const tc of delta.tool_calls) {
        const outcome = appendOrStart(tools, {
          index: tc.index,
          id: tc.id,
          name: tc.function?.name,
          argumentsDelta: tc.function?.arguments,
        })
        tools = outcome.state
        events.push(...outcome.events)
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      const finishTools = finishAll(tools)
      tools = finishTools.state
      events.push(...finishTools.events)
      pendingFinish = mapFinishReason(choice.finish_reason)
      if (chunk.usage !== undefined) {
        lifecycle = finalize(lifecycle, events, pendingFinish, mapUsage(chunk.usage))
        done = true
        pendingFinish = null
      }
    }
  } else if (chunk.usage !== undefined) {
    // Trailing usage-only chunk (choices empty) — finalize with stashed reason.
    const reason = pendingFinish ?? 'stop'
    lifecycle = finalize(lifecycle, events, reason, mapUsage(chunk.usage))
    done = true
    pendingFinish = null
  }

  return { state: { lifecycle, tools, pendingFinish }, events, done }
}

/** Finalize a stream that ended without a trailing usage chunk (no-op if already finished). */
const finalizeStream = (state: StepState): { events: StreamEvent[] } => {
  if (state.pendingFinish === null) return { events: [] }
  const events: StreamEvent[] = []
  const lifecycle = finalize(state.lifecycle, events, state.pendingFinish)
  void lifecycle
  return { events }
}

/** Parse a raw SSE data string into an OpenAI stream chunk; throws on bad JSON. */
const parseChunk = (routeId: string, raw: string): OpenAIStreamChunk => {
  try {
    return JSON.parse(raw) as OpenAIStreamChunk
  } catch {
    throw llmError(routeId, 'stream', {
      _tag: 'InvalidProviderOutput',
      message: 'Invalid OpenAI stream event',
      raw,
    })
  }
}

type RouteConfig = {
  id: string
  provider: string
  baseURL: string
  apiKey: string
  /** Optional extra headers (e.g. anthropic-version on compat proxies). */
  headers?: () => Record<string, string>
  defaults?: RouteDefaults
  /** Path override; defaults to /v1/chat/completions. */
  path?: string
}

/** Build a complete route descriptor for an OpenAI-compatible provider. */
const openAICompatRoute = (
  config: RouteConfig,
): {
  id: string
  provider: string
  protocol: 'openai-compat'
  baseURL: string
  path: string
  headers: () => Record<string, string>
  auth: { type: 'bearer'; apiKey: string }
  defaults?: RouteDefaults
} => ({
  id: config.id,
  provider: config.provider,
  protocol: 'openai-compat',
  baseURL: config.baseURL,
  path: config.path ?? '/v1/chat/completions',
  headers: config.headers ?? (() => ({})),
  auth: { type: 'bearer', apiKey: config.apiKey },
  defaults: config.defaults,
})

export type {
  OpenAIBody,
  OpenAIChatRole,
  OpenAIChoice,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIStreamChunk,
  OpenAITool,
  RouteConfig,
  StepState,
}
export {
  bodyFrom,
  finalizeStream,
  initialStepState,
  mapFinishReason,
  openAICompatRoute,
  parseChunk,
  step,
}
