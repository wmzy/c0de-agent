// Legacy createProvider() — thin adapter that exposes the old
// `createProvider(config) → { chat(...) }` surface used by api/ and friends.
//
// It runs a single OpenAI-compatible Chat Completions request (streaming or
// not) using the same fetch + SSE logic as the new canonical handler, but
// keeps the legacy wire shapes (Message, ToolCall, ToolDefinition, the
// `{type:'function', function:{...}}` nesting) so the un-migrated callers
// in api/ keep working.
//
// New code should use createProviderRegistry() + chatStream() from
// ./provider instead.

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  LLMProvider,
  LegacyProviderConfig,
  Message,
  ToolDefinition,
} from "./types-compat";

export function createProvider(config: LegacyProviderConfig): LLMProvider {
  const baseURL = config.baseUrl ?? "https://api.openai.com/v1";
  const model = config.model ?? "gpt-4o";
  const apiKey = config.apiKey;
  const maxTokens = config.maxTokens;
  const temperature = config.temperature;

  return {
    async chat(params: {
      messages: Message[];
      tools?: ToolDefinition[];
      stream?: boolean;
    }): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>> {
      const body: Record<string, unknown> = {
        model,
        messages: params.messages.map((m) => ({
          role: m.role,
          content: m.content ?? "",
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.name ? { name: m.name } : {}),
        })),
      };
      if (params.tools && params.tools.length > 0) body.tools = params.tools;
      if (maxTokens !== undefined) body.max_tokens = maxTokens;
      if (temperature !== undefined) body.temperature = temperature;

      if (params.stream) {
        return streamLegacyChat(baseURL, apiKey, body);
      }

      const response = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`LLM API error: ${response.status} ${text}`);
      }
      return (await response.json()) as ChatCompletionResponse;
    },
  };
}

async function* streamLegacyChat(
  baseURL: string,
  apiKey: string,
  body: Record<string, unknown>,
): AsyncIterable<ChatCompletionChunk> {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`LLM API error: ${response.status} ${text}`);
  }
  if (!response.body) throw new Error("No response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        if (!data) continue;
        try {
          yield JSON.parse(data) as ChatCompletionChunk;
        } catch {
          // Skip malformed lines.
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
}
