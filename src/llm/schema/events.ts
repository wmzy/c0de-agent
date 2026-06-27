import type {
  ContentBlockID,
  FinishReason,
  ProtocolID,
  ProviderMetadata,
  ResponseID,
  RouteID,
  ToolCallID,
} from './ids.js'
import type { Model } from './options.js'
import type { ToolResultValue } from './messages.js'

type Usage = {
  inputTokens?: number
  outputTokens?: number
  nonCachedInputTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  providerMetadata?: ProviderMetadata
}

type UsageInput = Partial<Usage>

const usageFrom = (input: UsageInput): Usage => {
  const inputTokens = input.inputTokens
  const outputTokens = input.outputTokens
  const total =
    input.totalTokens ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined)
  return { ...input, totalTokens: total }
}

/** Visible (non-reasoning) output tokens: max(0, output - reasoning). */
const visibleOutputTokens = (u: Usage): number => {
  const out = u.outputTokens ?? 0
  const reasoning = u.reasoningTokens ?? 0
  return Math.max(0, out - reasoning)
}

type StepStart = { type: 'step-start'; index: number }
type TextStart = { type: 'text-start'; id: ContentBlockID; providerMetadata?: ProviderMetadata }
type TextDelta = {
  type: 'text-delta'
  id: ContentBlockID
  text: string
  providerMetadata?: ProviderMetadata
}
type TextEnd = { type: 'text-end'; id: ContentBlockID; providerMetadata?: ProviderMetadata }
type ReasoningStart = {
  type: 'reasoning-start'
  id: ContentBlockID
  providerMetadata?: ProviderMetadata
}
type ReasoningDelta = {
  type: 'reasoning-delta'
  id: ContentBlockID
  text: string
  providerMetadata?: ProviderMetadata
}
type ReasoningEnd = { type: 'reasoning-end'; id: ContentBlockID; providerMetadata?: ProviderMetadata }
type ToolInputStart = {
  type: 'tool-input-start'
  id: ToolCallID
  name: string
  providerMetadata?: ProviderMetadata
}
type ToolInputDelta = {
  type: 'tool-input-delta'
  id: ToolCallID
  name: string
  text: string
  providerMetadata?: ProviderMetadata
}
type ToolInputEnd = {
  type: 'tool-input-end'
  id: ToolCallID
  name: string
  providerMetadata?: ProviderMetadata
}
type ToolCallEvent = {
  type: 'tool-call'
  id: ToolCallID
  name: string
  input: unknown
  providerExecuted?: boolean
  providerMetadata?: ProviderMetadata
}
type ToolResultEvent = {
  type: 'tool-result'
  id: ToolCallID
  name: string
  result: ToolResultValue
  providerExecuted?: boolean
  providerMetadata?: ProviderMetadata
}
type ToolErrorEvent = {
  type: 'tool-error'
  id: ToolCallID
  name: string
  message: string
  providerMetadata?: ProviderMetadata
}
type StepFinish = {
  type: 'step-finish'
  index: number
  reason: FinishReason
  usage?: Usage
  providerMetadata?: ProviderMetadata
}
type FinishEvent = {
  type: 'finish'
  reason: FinishReason
  usage?: Usage
  providerMetadata?: ProviderMetadata
  responseId?: ResponseID
}
type ProviderErrorEvent = {
  type: 'provider-error'
  message: string
  classification?: 'context-overflow'
  retryable?: boolean
  providerMetadata?: ProviderMetadata
}

type StreamEvent =
  | StepStart
  | TextStart
  | TextDelta
  | TextEnd
  | ReasoningStart
  | ReasoningDelta
  | ReasoningEnd
  | ToolInputStart
  | ToolInputDelta
  | ToolInputEnd
  | ToolCallEvent
  | ToolResultEvent
  | ToolErrorEvent
  | StepFinish
  | FinishEvent
  | ProviderErrorEvent

type PreparedRequest = {
  id: string
  route: RouteID
  protocol: ProtocolID
  model: Model
  body: unknown
}

type LLMResponse = {
  events: StreamEvent[]
  usage?: Usage
}

/** Fold a list of events into an LLMResponse (used by non-streaming chat). */
const foldResponse = (events: StreamEvent[]): LLMResponse => {
  let usage: Usage | undefined
  for (const event of events) {
    if (
      (event.type === 'finish' || event.type === 'step-finish') &&
      event.usage !== undefined
    ) {
      usage = event.usage
    }
  }
  return { events, usage }
}

const responseText = (res: LLMResponse): string =>
  res.events
    .filter((e): e is TextDelta => e.type === 'text-delta')
    .map((e) => e.text)
    .join('')

const responseReasoning = (res: LLMResponse): string =>
  res.events
    .filter((e): e is ReasoningDelta => e.type === 'reasoning-delta')
    .map((e) => e.text)
    .join('')

const responseToolCalls = (res: LLMResponse): ToolCallEvent[] =>
  res.events.filter((e): e is ToolCallEvent => e.type === 'tool-call')

export type {
  FinishEvent,
  LLMResponse,
  PreparedRequest,
  ProviderErrorEvent,
  ReasoningDelta,
  ReasoningEnd,
  ReasoningStart,
  StepFinish,
  StepStart,
  StreamEvent,
  TextDelta,
  TextEnd,
  TextStart,
  ToolCallEvent,
  ToolErrorEvent,
  ToolInputDelta,
  ToolInputEnd,
  ToolInputStart,
  ToolResultEvent,
  Usage,
  UsageInput,
}
export {
  foldResponse,
  responseReasoning,
  responseText,
  responseToolCalls,
  usageFrom,
  visibleOutputTokens,
}
