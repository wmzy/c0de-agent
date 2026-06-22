// Agent core loop

import type { LLMProvider, Message } from '@/llm'
import type { ToolExecutor, ToolRegistry } from '@/tools'
import { DEFAULT_SYSTEM_PROMPT } from './prompts'
import type { AgentConfig, AgentEvent, AgentRunner } from './types'

const DEFAULT_MAX_ITERATIONS = 20

export class DefaultAgentRunner implements AgentRunner {
  private messages: Message[] = []
  private provider: LLMProvider
  private tools: ToolRegistry
  private executor: ToolExecutor
  private config: Required<Pick<AgentConfig, 'systemPrompt' | 'maxIterations'>> &
    Pick<AgentConfig, 'workingDirectory'>
  private toolContext: { workingDirectory: string; env: Record<string, string | undefined> }

  constructor(params: {
    provider: LLMProvider
    tools: ToolRegistry
    executor: ToolExecutor
    config?: AgentConfig
  }) {
    this.provider = params.provider
    this.tools = params.tools
    this.executor = params.executor
    this.config = {
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      maxIterations: DEFAULT_MAX_ITERATIONS,
      ...params.config,
    }
    this.toolContext = {
      workingDirectory: params.config?.workingDirectory ?? process.cwd(),
      env: process.env,
    }
  }

  async *run(userMessage: string): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: 'user', content: userMessage })

    if (this.messages.length === 1) {
      this.messages.unshift({
        role: 'system',
        content: this.config.systemPrompt,
      })
    }

    for (let i = 0; i < this.config.maxIterations; i++) {
      const response = await this.provider.chat({
        messages: this.messages,
        tools: this.tools.toDefinitions(),
        stream: false,
      })

      if (!('choices' in response)) {
        yield { type: 'error', data: 'Unexpected response format' }
        return
      }

      const choice = response.choices[0]
      const assistantMessage = choice.message

      this.messages.push(assistantMessage)

      if (assistantMessage.content) {
        yield { type: 'message', data: assistantMessage.content }
      }

      if (choice.finish_reason === 'tool_calls' && assistantMessage.tool_calls) {
        for (const toolCall of assistantMessage.tool_calls) {
          yield {
            type: 'tool_call',
            data: {
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          }

          const result = await this.executor.execute(toolCall, this.toolContext)

          this.messages.push({
            role: 'tool',
            content: result.error ? `Error: ${result.error}` : result.output,
            tool_call_id: toolCall.id,
          })

          yield {
            type: 'tool_result',
            data: {
              id: toolCall.id,
              name: toolCall.function.name,
              output: result.output,
              error: result.error,
            },
          }
        }
      } else {
        yield { type: 'done', data: null }
        return
      }
    }

    yield { type: 'done', data: null }
  }

  reset(): void {
    this.messages = []
  }

  getMessages(): Message[] {
    return [...this.messages]
  }
}

export function createAgent(params: {
  provider: LLMProvider
  tools: ToolRegistry
  executor: ToolExecutor
  config?: AgentConfig
}): AgentRunner {
  return new DefaultAgentRunner(params)
}

export type { AgentConfig, AgentEvent, AgentRunner } from './types'
export { DEFAULT_SYSTEM_PROMPT } from './prompts'
