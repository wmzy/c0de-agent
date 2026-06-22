// OpenAI-compatible provider

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  LLMProvider,
  ProviderConfig,
} from './types'

export class OpenAIProvider implements LLMProvider {
  private config: Required<Pick<ProviderConfig, 'apiKey' | 'baseUrl' | 'model'>> &
    Pick<ProviderConfig, 'maxTokens' | 'temperature'>

  constructor(config: ProviderConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
      model: config.model ?? 'gpt-4o',
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    }
  }

  async chat(params: {
    messages: import('./types').Message[]
    tools?: import('./types').ToolDefinition[]
    stream?: boolean
  }): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: params.messages,
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools
    }

    if (this.config.maxTokens !== undefined) {
      body.max_tokens = this.config.maxTokens
    }

    if (this.config.temperature !== undefined) {
      body.temperature = this.config.temperature
    }

    if (params.stream) {
      return this.streamChat(body)
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`LLM API error: ${response.status} ${error}`)
    }

    return (await response.json()) as ChatCompletionResponse
  }

  private async *streamChat(
    body: Record<string, unknown>
  ): AsyncIterable<ChatCompletionChunk> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ ...body, stream: true }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`LLM API error: ${response.status} ${error}`)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue

          const data = trimmed.slice(6)
          if (data === '[DONE]') return

          try {
            yield JSON.parse(data) as ChatCompletionChunk
          } catch {
            // Skip invalid JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}

export function createProvider(config: ProviderConfig): LLMProvider {
  return new OpenAIProvider(config)
}
