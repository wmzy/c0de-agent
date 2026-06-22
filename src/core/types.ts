// @c0de/core - Type definitions

import type { LLMProvider, Message } from "@c0de/llm";
import type { ToolContext, ToolRegistry } from "@c0de/tools";

export interface AgentConfig {
  systemPrompt?: string;
  maxIterations?: number;
  workingDirectory?: string;
}

export interface AgentContext {
  messages: Message[];
  tools: ToolRegistry;
  provider: LLMProvider;
  config: AgentConfig;
  toolContext: ToolContext;
}

export interface AgentEvent {
  type: "message" | "tool_call" | "tool_result" | "done" | "error";
  data: unknown;
}

export interface AgentRunner {
  run(userMessage: string): AsyncGenerator<AgentEvent>;
  reset(): void;
}
