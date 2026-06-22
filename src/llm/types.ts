// LLM type definitions

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

export interface ChatCompletionChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: 'assistant'
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason: 'stop' | 'tool_calls' | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface ChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: Message
    finish_reason: 'stop' | 'tool_calls'
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface ProviderConfig {
  apiKey: string
  baseUrl?: string
  model?: string
  maxTokens?: number
  temperature?: number
}

export interface LLMProvider {
  chat(params: {
    messages: Message[]
    tools?: ToolDefinition[]
    stream?: boolean
  }): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>>
}
