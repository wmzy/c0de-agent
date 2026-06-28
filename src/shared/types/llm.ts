import type { JSONSchema } from './base.js'

/** Supported LLM provider protocols. */
type ProviderProtocol = 'openai' | 'anthropic' | 'google' | 'openai-compat'

/** Provider configuration entry. */
type ProviderConfig = {
  name: string
  protocol: ProviderProtocol
  apiKey: string
  baseURL?: string
  models?: Record<string, ModelOverride>
}

/** Per-model configuration overrides. */
type ModelOverride = {
  /** 是否在会话模型选择器中启用。省略或 true 为启用；false 为禁用（仍保留记录）。 */
  enabled?: boolean
  contextWindow?: number
  maxOutput?: number
  supportsTools?: boolean
  supportsVision?: boolean
  supportsThinking?: boolean
  costPer1kInput?: number
  costPer1kOutput?: number
}

/** Static model capability descriptor. */
type ModelCapabilities = {
  contextWindow: number
  maxOutput: number
  supportsTools: boolean
  supportsVision: boolean
  supportsThinking: boolean
  costPer1kInput: number
  costPer1kOutput: number
}

/** Role tag for multi-model routing. */
type ModelRole =
  | { readonly _tag: 'default' }
  | { readonly _tag: 'smol' }
  | { readonly _tag: 'slow' }
  | { readonly _tag: 'plan' }
  | { readonly _tag: 'commit' }

/** Content part for multimodal messages (text or image). */
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string }

/** Protocol-level chat message sent to the LLM provider. */
type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  toolCallId?: string
  toolCalls?: { id: string; name: string; arguments: string }[]
}

/** Tool definition as sent to the LLM provider. */
type ChatTool = {
  name: string
  description: string
  parameters: JSONSchema
}

/** Request to the LLM provider. */
type ChatRequest = {
  model: string
  messages: ChatMessage[]
  tools?: ChatTool[]
  stream: true
  maxTokens?: number
  temperature?: number
  system?: string
}

/**
 * Streaming chunk from the LLM provider.
 * Tool calls stream in three phases: start → delta(s) → end.
 * The LLM package normalizes all provider formats to this union.
 */
type StreamChunk =
  | { _tag: 'text'; text: string }
  | { _tag: 'tool_call_start'; id: string; name: string }
  | { _tag: 'tool_call_delta'; id: string; argumentsDelta: string }
  | { _tag: 'tool_call_end'; id: string; argumentsFinal?: string }
  | { _tag: 'thinking'; text: string }
  | {
      _tag: 'usage'
      inputTokens: number
      outputTokens: number
      cacheRead?: number
    }
  | { _tag: 'done' }
  | { _tag: 'error'; error: { message: string; retryable?: boolean } }

export type {
  ChatMessage,
  ChatRequest,
  ChatTool,
  ContentPart,
  ModelCapabilities,
  ModelOverride,
  ModelRole,
  ProviderConfig,
  ProviderProtocol,
  StreamChunk,
}
