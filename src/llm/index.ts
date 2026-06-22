// @c0de/llm - Provider abstraction, streaming, token counting

export const VERSION = "0.0.1";

export type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  LLMProvider,
  Message,
  ProviderConfig,
  ToolCall,
  ToolDefinition,
} from "./types";

export { OpenAIProvider, createProvider } from "./openai";
