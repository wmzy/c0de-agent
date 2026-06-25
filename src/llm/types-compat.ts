// Legacy type aliases — kept for the agent/, tools/, api/ packages that have
// not yet migrated to the §4 protocol-level types. This module is the single
// source of truth for the legacy names so consumers can keep their imports
// stable. Once those packages are migrated, delete this module and the
// legacy re-exports in index.ts.

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

/** @deprecated Use the tagged union `ProviderConfig` from `./types`. */
export type LegacyProviderConfig = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

export type ChatCompletionUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type ChatCompletionChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | null;
  }>;
  usage?: ChatCompletionUsage;
};

export type ChatCompletionResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: Message;
    finish_reason: "stop" | "tool_calls" | "length" | "content_filter";
  }>;
  usage: ChatCompletionUsage;
};

export type LLMProvider = {
  chat(params: {
    messages: Message[];
    tools?: ToolDefinition[];
    stream?: boolean;
  }): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>>;
};
