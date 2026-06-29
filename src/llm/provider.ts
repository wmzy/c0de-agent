import type {
  ContentPart as ChatContentPart,
  ChatMessage,
  ChatRequest,
  ChatTool,
  StreamChunk,
} from '../shared/types/llm.js'
import type { StepState } from './protocols/openai-compat.js'
import {
  bodyFrom,
  finalizeStream,
  initialStepState,
  parseChunk,
  step,
} from './protocols/openai-compat.js'
import type { Registry } from './registry.js'
import { resolveRoute } from './registry.js'
import { withRetry } from './retry.js'
import type { FallbackChain } from './routing.js'
import { shouldFallOver } from './routing.js'
import type { StreamEvent } from './schema/events.js'
import type { ContentPart, InternalRequest, Message, ToolDefinition } from './schema/messages.js'
import { model as makeModel } from './schema/options.js'
import { httpPost, sseFraming } from './transport.js'

type ProviderContext = {
  registry: Registry
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

const safeParseArgs = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Map a shared ChatMessage to the internal Message shape. */
const toInternalMessage = (msg: ChatMessage): Message => {
  // tool role messages carry tool result text — MUST handle before the
  // string-content early return below, because context.ts serialises tool
  // result output to a JSON string (msg.content is a string for tool msgs).
  // If this runs after the early return, toolCallId is lost and the provider
  // receives a tool message without tool_call_id → "invalid tool_call_id".
  if (msg.role === 'tool' && msg.toolCallId !== undefined) {
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : (msg.content as ChatContentPart[]).map((p) => (p.type === 'text' ? p.text : '')).join('')
    return {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          id: msg.toolCallId,
          name: 'tool',
          result: { type: 'text', value: text },
        },
      ],
    }
  }
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: [{ type: 'text', text: msg.content }] }
  }
  const parts: ContentPart[] = (msg.content as ChatContentPart[]).map((p) => {
    if (p.type === 'text') return { type: 'text' as const, text: p.text }
    return { type: 'text' as const, text: `[image: ${p.mediaType}]` }
  })
  // assistant messages may carry tool_calls
  if (msg.role === 'assistant' && msg.toolCalls !== undefined) {
    const toolParts: ContentPart[] = msg.toolCalls.map((tc) => ({
      type: 'tool-call',
      id: tc.id,
      name: tc.name,
      input: safeParseArgs(tc.arguments),
    }))
    return { role: 'assistant', content: [...parts, ...toolParts] }
  }
  return { role: msg.role, content: parts }
}

const toInternalTool = (tool: ChatTool): ToolDefinition => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.parameters,
})

/** Map a rich StreamEvent to the shared, agent-facing StreamChunk. */
const toStreamChunk = (event: StreamEvent): StreamChunk | null => {
  switch (event.type) {
    case 'text-delta':
      return { _tag: 'text', text: event.text }
    case 'tool-input-start':
      return { _tag: 'tool_call_start', id: event.id, name: event.name }
    case 'tool-input-delta':
      return { _tag: 'tool_call_delta', id: event.id, argumentsDelta: event.text }
    case 'tool-input-end':
      // Redundant: the finalized `tool-call` event below carries the complete
      // parsed input and maps to tool_call_end. Emitting both would duplicate
      // the end signal per tool call.
      return null
    case 'tool-call':
      return { _tag: 'tool_call_end', id: event.id, argumentsFinal: JSON.stringify(event.input) }
    case 'reasoning-delta':
      return { _tag: 'thinking', text: event.text }
    case 'step-finish':
      if (event.usage !== undefined) {
        return {
          _tag: 'usage',
          inputTokens: event.usage.inputTokens ?? 0,
          outputTokens: event.usage.outputTokens ?? 0,
          cacheRead: event.usage.cacheReadInputTokens,
        }
      }
      return null
    case 'finish':
      return { _tag: 'done' }
    case 'provider-error':
      return {
        _tag: 'error',
        error: { message: event.message, retryable: event.retryable ?? false },
      }
    default:
      return null
  }
}

type ChatOptions = {
  provider: string
  model: string
  fallback?: FallbackChain
  /** Override sleep for retry testing. */
  sleep?: (ms: number) => Promise<void>
}

const buildInternalRequest = (
  request: ChatRequest,
  provider: string,
  modelId: string,
): InternalRequest => ({
  model: makeModel(modelId, provider),
  system: request.system !== undefined ? [{ type: 'text', text: request.system }] : [],
  messages: request.messages.map(toInternalMessage),
  tools: (request.tools ?? []).map(toInternalTool),
  generation: {
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  },
  toolChoice:
    request.tools !== undefined && request.tools.length > 0 ? { type: 'auto' } : undefined,
})

const resolveChain = (options: ChatOptions): FallbackChain =>
  options.fallback ?? {
    primary: { provider: options.provider, model: options.model },
    fallbacks: [],
    maxRetries: 3,
    retryDelay: 2000,
    sleep: options.sleep,
  }

/** Open a (retryable) connection to one target route and stream its StreamChunks. */
const streamTarget = async function* (
  ctx: ProviderContext,
  request: ChatRequest,
  target: { provider: string; model: string },
  chain: FallbackChain,
): AsyncGenerator<StreamChunk, void, unknown> {
  const resolved = resolveRoute(ctx.registry, target.provider, target.model)
  const internal = buildInternalRequest(request, target.provider, target.model)
  const body = bodyFrom(internal)
  const url = `${resolved.route.baseURL}${resolved.route.path}`
  const authHeader = resolved.route.auth.type === 'bearer' ? resolved.route.auth.apiKey : ''
  // Retry only the connection (the fetch). Once streaming begins, errors propagate.
  const stream = await withRetry(
    () =>
      httpPost({
        url,
        body,
        headers: { authorization: `Bearer ${authHeader}`, ...resolved.route.headers() },
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
      }),
    { maxRetries: chain.maxRetries, sleep: chain.sleep },
  )
  let state: StepState = initialStepState()
  for await (const frame of sseFraming(stream)) {
    const chunk = parseChunk(resolved.route.id, frame)
    const result = step(state, chunk)
    state = result.state
    for (const event of result.events) {
      const sc = toStreamChunk(event)
      if (sc !== null) yield sc
    }
  }
  // Stream ended without a trailing usage chunk — finalize (no-op if already finished).
  for (const event of finalizeStream(state).events) {
    const sc = toStreamChunk(event)
    if (sc !== null) yield sc
  }
}

/**
 * Stream a chat request incrementally as agent-facing StreamChunk values.
 * Retries/falls over only BEFORE the first chunk is yielded; once streaming
 * begins, errors propagate to the caller (per spec §7.6 fall-over policy).
 */
const chatStream = async function* (
  ctx: ProviderContext,
  request: ChatRequest,
  options: ChatOptions,
): AsyncGenerator<StreamChunk, void, unknown> {
  const chain = resolveChain(options)
  const targets = [chain.primary, ...chain.fallbacks]
  let started = false
  let lastError: unknown

  for (const target of targets) {
    if (target === undefined) continue
    resolveRoute(ctx.registry, target.provider, target.model) // fail-fast NoRoute
    try {
      for await (const sc of streamTarget(ctx, request, target, chain)) {
        started = true
        yield sc
      }
      return
    } catch (error) {
      lastError = error
      if (started || !shouldFallOver(error)) throw error
    }
  }
  throw lastError
}

/** Non-streaming chat: consume the stream and return the final text. */
const chat = async (
  ctx: ProviderContext,
  request: ChatRequest,
  options: ChatOptions,
): Promise<string> => {
  let text = ''
  for await (const chunk of chatStream(ctx, request, options)) {
    if (chunk._tag === 'text') text += chunk.text
  }
  return text
}

export type { ChatOptions, ProviderContext }
export { buildInternalRequest, chat, chatStream, toInternalMessage, toStreamChunk }
