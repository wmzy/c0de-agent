import type {
  ContentPart as ChatContentPart,
  ChatMessage,
  ChatRequest,
  ChatTool,
  StreamChunk,
} from '../shared/types/llm.js'
import type { StepState } from './protocols/openai-compat.js'
import { bodyFrom, initialStepState, parseChunk, step } from './protocols/openai-compat.js'
import type { Registry } from './registry.js'
import { resolveRoute } from './registry.js'
import type { FallbackChain } from './routing.js'
import { runWithFallback } from './routing.js'
import type { StreamEvent } from './schema/events.js'
import type { ContentPart, InternalRequest, Message, ToolDefinition } from './schema/messages.js'
import { model as makeModel } from './schema/options.js'
import { streamHTTP } from './transport.js'

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
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: [{ type: 'text', text: msg.content }] }
  }
  const parts: ContentPart[] = (msg.content as ChatContentPart[]).map((p) => {
    if (p.type === 'text') return { type: 'text' as const, text: p.text }
    return { type: 'text' as const, text: `[image: ${p.mediaType}]` }
  })
  // tool role messages carry tool result text
  if (msg.role === 'tool' && msg.toolCallId !== undefined) {
    const text = parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
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
      return { _tag: 'tool_call_end', id: event.id }
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

const collectEvents = async (
  ctx: ProviderContext,
  request: ChatRequest,
  options: ChatOptions,
): Promise<StreamEvent[]> => {
  const chain: FallbackChain = options.fallback ?? {
    primary: { provider: options.provider, model: options.model },
    fallbacks: [],
    maxRetries: 3,
    retryDelay: 2000,
    sleep: options.sleep,
  }

  const { result: events } = await runWithFallback(
    ctx.registry,
    chain,
    async (providerArg, modelArg) => {
      const resolved = resolveRoute(ctx.registry, providerArg, modelArg)
      const internal = buildInternalRequest(request, providerArg, modelArg)
      const body = bodyFrom(internal)
      const url = `${resolved.route.baseURL}${resolved.route.path}`
      const authHeader = resolved.route.auth.type === 'bearer' ? resolved.route.auth.apiKey : ''
      const collected: StreamEvent[] = []
      let state: StepState = initialStepState()
      for await (const frame of streamHTTP({
        url,
        body,
        headers: { authorization: `Bearer ${authHeader}`, ...resolved.route.headers() },
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
      })) {
        const chunk = parseChunk(resolved.route.id, frame)
        const result = step(state, chunk)
        state = result.state
        collected.push(...result.events)
        if (result.done) break
      }
      return collected
    },
  )
  return events
}

/**
 * Stream a chat request as agent-facing StreamChunk values.
 * Each yielded chunk is the normalized form Plans 4-6 consume.
 */
const chatStream = async function* (
  ctx: ProviderContext,
  request: ChatRequest,
  options: ChatOptions,
): AsyncGenerator<StreamChunk, void, unknown> {
  const events = await collectEvents(ctx, request, options)
  for (const event of events) {
    const chunk = toStreamChunk(event)
    if (chunk !== null) yield chunk
  }
}

/** Non-streaming chat: collect all events and return the final text. */
const chat = async (
  ctx: ProviderContext,
  request: ChatRequest,
  options: ChatOptions,
): Promise<string> => {
  const events = await collectEvents(ctx, request, options)
  return events
    .filter((e): e is Extract<StreamEvent, { type: 'text-delta' }> => e.type === 'text-delta')
    .map((e) => e.text)
    .join('')
}

export type { ChatOptions, ProviderContext }
export { buildInternalRequest, chat, chatStream, toInternalMessage, toStreamChunk }
