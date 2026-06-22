// @c0de/core - Agent core loop

import type { LLMProvider, Message } from "@c0de/llm";
import type { ToolExecutor, ToolRegistry } from "@c0de/tools";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts";
import type { AgentConfig, AgentContext, AgentEvent, AgentRunner } from "./types";

const DEFAULT_MAX_ITERATIONS = 20;

export class DefaultAgentRunner implements AgentRunner {
  private messages: Message[] = [];
  private context: AgentContext;

  constructor(params: {
    provider: LLMProvider;
    tools: ToolRegistry;
    executor: ToolExecutor;
    config?: AgentConfig;
  }) {
    this.context = {
      messages: [],
      tools: params.tools,
      provider: params.provider,
      config: {
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        maxIterations: DEFAULT_MAX_ITERATIONS,
        workingDirectory: process.cwd(),
        ...params.config,
      },
      toolContext: {
        workingDirectory: params.config?.workingDirectory ?? process.cwd(),
        env: process.env as Record<string, string>,
      },
    };

    // Set up executor with context
    this.executor = params.executor;
  }

  private executor: ToolExecutor;

  async *run(userMessage: string): AsyncGenerator<AgentEvent> {
    // Add user message
    this.messages.push({ role: "user", content: userMessage });

    // Add system prompt if this is the first message
    if (this.messages.length === 1) {
      this.messages.unshift({
        role: "system",
        content: this.context.config.systemPrompt ?? null,
      });
    }

    const maxIterations = this.context.config.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    for (let i = 0; i < maxIterations; i++) {
      // Call LLM
      const response = await this.context.provider.chat({
        messages: this.messages,
        tools: this.context.tools.toDefinitions(),
        stream: false,
      });

      if (!("choices" in response)) {
        yield { type: "error", data: "Unexpected response format" };
        return;
      }

      const choice = response.choices[0];
      const assistantMessage = choice.message;

      // Add assistant message to history
      this.messages.push(assistantMessage);

      // Yield the message content if present
      if (assistantMessage.content) {
        yield { type: "message", data: assistantMessage.content };
      }

      // Check if we need to call tools
      if (choice.finish_reason === "tool_calls" && assistantMessage.tool_calls) {
        for (const toolCall of assistantMessage.tool_calls) {
          yield {
            type: "tool_call",
            data: {
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          };

          // Execute tool
          const result = await this.executor.execute(toolCall, this.context.toolContext);

          // Add tool result to messages
          this.messages.push({
            role: "tool",
            content: result.error ? `Error: ${result.error}` : result.output,
            tool_call_id: toolCall.id,
          });

          yield {
            type: "tool_result",
            data: {
              id: toolCall.id,
              name: toolCall.function.name,
              output: result.output,
              error: result.error,
            },
          };
        }
      } else {
        // No more tool calls, we're done
        yield { type: "done", data: null };
        return;
      }
    }

    yield { type: "done", data: null };
  }

  reset(): void {
    this.messages = [];
  }

  getMessages(): Message[] {
    return [...this.messages];
  }
}

export function createAgent(params: {
  provider: LLMProvider;
  tools: ToolRegistry;
  executor: ToolExecutor;
  config?: AgentConfig;
}): AgentRunner {
  return new DefaultAgentRunner(params);
}
