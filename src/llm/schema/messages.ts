import type {
  CacheHint,
  GenerationOptions,
  HttpOptions,
  Model,
  ProviderOptions,
} from './options.js'
import type { JsonSchema, ProviderMetadata, ToolCallID } from './ids.js'

type SystemPart = {
  type: 'text'
  text: string
  cache?: CacheHint
  metadata?: Record<string, unknown>
}

type TextPart = {
  type: 'text'
  text: string
  cache?: CacheHint
  providerMetadata?: ProviderMetadata
}

type ReasoningPart = {
  type: 'reasoning'
  text: string
  encrypted?: string
  providerMetadata?: ProviderMetadata
}

type ToolCallPart = {
  type: 'tool-call'
  id: ToolCallID
  name: string
  input: unknown
  providerExecuted?: boolean
  providerMetadata?: ProviderMetadata
}

type ToolResultValue =
  | { type: 'json'; value: unknown }
  | { type: 'text'; value: unknown }
  | { type: 'error'; value: unknown }

type ToolResultPart = {
  type: 'tool-result'
  id: ToolCallID
  name: string
  result: ToolResultValue
  providerExecuted?: boolean
  cache?: CacheHint
  providerMetadata?: ProviderMetadata
}

type ContentPart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart

type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

type Message = {
  id?: string
  role: MessageRole
  content: ContentPart[]
  metadata?: Record<string, unknown>
}

const messageUser = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
})

const messageAssistant = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
})

const messageSystem = (text: string): Message => ({
  role: 'system',
  content: [{ type: 'text', text }],
})

type ToolDefinition = {
  name: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  cache?: CacheHint
}

type ToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'required' }
  | { type: 'tool'; name: string }

type ResponseFormat =
  | { type: 'text' }
  | { type: 'json'; schema: JsonSchema }

type InternalRequest = {
  id?: string
  model: Model
  system: SystemPart[]
  messages: Message[]
  tools: ToolDefinition[]
  toolChoice?: ToolChoice
  generation?: GenerationOptions
  providerOptions?: ProviderOptions
  http?: HttpOptions
  responseFormat?: ResponseFormat
}

/** Immutable patch of an InternalRequest. */
const requestUpdate = (req: InternalRequest, patch: Partial<InternalRequest>): InternalRequest => ({
  ...req,
  ...patch,
})

export type {
  ContentPart,
  InternalRequest,
  Message,
  MessageRole,
  ReasoningPart,
  ResponseFormat,
  SystemPart,
  TextPart,
  ToolCallPart,
  ToolChoice,
  ToolDefinition,
  ToolResultPart,
  ToolResultValue,
}
export { messageAssistant, messageSystem, messageUser, requestUpdate }
