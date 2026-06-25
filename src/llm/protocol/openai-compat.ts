// OpenAI-compatible protocol handler (§4 + §4.8).
//
// Covers providers that expose an OpenAI Chat Completions-shaped endpoint
// but are not OpenAI itself: DeepSeek, Groq, Together, Mistral, Fireworks,
// OpenRouter, etc. The wire shape is identical to OpenAI Chat Completions,
// so the body conversion and SSE parsing are factored through openai.ts.
//
// Differences vs the canonical OpenAI handler:
//   - baseURL is required (no default).
//   - No Responses API path.
//   - Provider-specific headers (Groq / OpenRouter ask for identifying
//     metadata; we forward optional `label` as a User-Agent fragment).
//
// ── §4.8 Cache Stability ─────────────────────────────────────────────
//
// DeepSeek and other OpenAI-compatible providers perform automatic prefix
// caching on the request body. To maximise cache hits we guarantee:
//
//   1. System prompt is always the FIRST message and never contains
//      timestamps, session IDs, or other per-request dynamic content.
//      The caller MUST strip such metadata before reaching this layer.
//
//   2. Tool definitions are emitted in a deterministic order matching the
//      input `tools` array. No dynamic fields (timestamps, counters) are
//      injected. The same tools → identical serialisation.
//
//   3. Message history is appended AFTER the stable prefix (system + tools)
//      in chronological order. As the conversation grows, the prefix stays
//      identical so the provider can skip re-processing it.
//
// Unlike Anthropic (explicit cache_control breakpoints) or Google
// (cached content API), OpenAI-compatible providers do not expose a cache
// header — prefix stability alone is sufficient.

import { chunkDone, chunkError, chunkText, chunkToolCall, chunkUsage, parseSSE } from "../stream";
import { isRetriableStatus } from "./utils";
import type { ChatRequest, ProtocolHandler, ProviderConfig, StreamChunk } from "../types";

type CompatConfig = Extract<ProviderConfig, { _tag: "openai-compat" }>;

type CompatToolCallDelta = {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
};

type CompatChoice = {
  index: number;
  delta: {
    role?: "assistant";
    content?: string | null;
    tool_calls?: CompatToolCallDelta[];
  };
  finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | null;
};

type CompatChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: CompatChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

type CompatMessageRole = "system" | "user" | "assistant" | "tool";

type CompatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

type CompatMessage =
  | {
      role: CompatMessageRole;
      content: string | CompatContentPart[];
      tool_call_id?: string;
      name?: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };

type CompatRequestBody = {
  model: string;
  messages: CompatMessage[];
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: unknown };
  }>;
  stream: true;
  stream_options?: { include_usage: true };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
};

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createOpenAICompatHandler(_config: ProviderConfig): ProtocolHandler {
  return {
    name: "openai-compat",
    chat(request: ChatRequest, config: ProviderConfig): AsyncGenerator<StreamChunk> {
      return openAICompatChatStream(request, config as CompatConfig);
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming entrypoint
// ---------------------------------------------------------------------------

async function* openAICompatChatStream(
  request: ChatRequest,
  config: CompatConfig,
): AsyncGenerator<StreamChunk> {
  // Defensive: the openai-compat _tag guarantees baseURL, but stay safe at runtime.
  const baseURL = config.baseURL.replace(/\/+$/, "");
  if (!config.apiKey) {
    yield chunkError("openai-compat provider requires an apiKey", false, "config_missing_key");
    return;
  }

  const messages = toCompatMessages(request);
  const tools = request.tools ? toCompatTools(request.tools) : undefined;

  const body: CompatRequestBody = {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools) body.tools = tools;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.stop !== undefined && request.stop.length > 0) body.stop = request.stop;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
  if (config.label) {
    headers["X-Provider"] = config.label;
    headers["User-Agent"] = `c0de-agent/${config.label}`;
  }

  let response: Response;
  try {
    response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    yield chunkError(err instanceof Error ? err.message : String(err), true, "network");
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    yield chunkError(
      `${config.label ?? "openai-compat"} ${response.status}: ${text || response.statusText}`,
      isRetriableStatus(response.status),
      `http_${response.status}`,
    );
    return;
  }
  if (!response.body) {
    yield chunkError(
      `${config.label ?? "openai-compat"} returned an empty body`,
      false,
      "empty_body",
    );
    return;
  }

  yield* streamCompatChunks(response.body);
}

// ---------------------------------------------------------------------------
// SSE → StreamChunk
// ---------------------------------------------------------------------------

async function* streamCompatChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let emittedUsage = false;

  for await (const sse of parseSSE(body)) {
    if (sse.data === "[DONE]") break;
    if (!sse.data) continue;

    let chunk: CompatChunk;
    try {
      chunk = JSON.parse(sse.data) as CompatChunk;
    } catch {
      continue;
    }

    for (const choice of chunk.choices) {
      const delta = choice.delta;

      if (delta.content) {
        yield chunkText(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let entry = toolAcc.get(tc.index);
          if (!entry) {
            entry = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
            toolAcc.set(tc.index, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
        }
      }
    }

    if (chunk.usage && !emittedUsage) {
      emittedUsage = true;
      yield chunkUsage(chunk.usage.prompt_tokens, chunk.usage.completion_tokens);
    }
  }

  for (const entry of toolAcc.values()) {
    if (entry.id && entry.name) {
      yield chunkToolCall(entry.id, entry.name, entry.args);
    }
  }

  yield chunkDone();
}

// ---------------------------------------------------------------------------
// Message / tool conversion
// ---------------------------------------------------------------------------

function toCompatMessages(request: ChatRequest): CompatMessage[] {
  // §4.8 — Build a cache-stable message array:
  // 1. System prompt (if any) is always first — no timestamps injected.
  // 2. Conversation history follows in chronological order.
  // The provider detects the identical prefix across turns and skips
  // re-processing, saving latency and tokens.
  const out: CompatMessage[] = [];

  const inlineSystem = request.messages.filter((m) => m.role === "system");
  const systemText =
    request.system ??
    (inlineSystem.length > 0
      ? inlineSystem.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n\n")
      : undefined);

  if (systemText !== undefined && systemText.length > 0) {
    out.push({ role: "system", content: systemText });
  }

  for (const message of request.messages) {
    if (message.role === "system") continue;

    if (message.role === "assistant") {
      const assistantOut: {
        role: "assistant";
        content: string | null;
        tool_calls?: Array<{
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }>;
      } = {
        role: "assistant",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((p) => (p._tag === "text" ? p.text : "")).join(""),
      };
      if (message.toolCalls && message.toolCalls.length > 0) {
        assistantOut.tool_calls = message.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      out.push(assistantOut);
      continue;
    }

    if (message.role === "tool") {
      const toolOut: { role: "tool"; content: string; tool_call_id?: string; name?: string } = {
        role: "tool",
        content: typeof message.content === "string" ? message.content : "",
      };
      if (message.toolCallId) toolOut.tool_call_id = message.toolCallId;
      if (message.name) toolOut.name = message.name;
      out.push(toolOut);
      continue;
    }

    // user
    if (typeof message.content === "string") {
      out.push({ role: "user", content: message.content });
    } else {
      const parts: CompatContentPart[] = [];
      for (const part of message.content) {
        if (part._tag === "text") parts.push({ type: "text", text: part.text });
        else if (part._tag === "image_url")
          parts.push({ type: "image_url", image_url: { url: part.url, detail: part.detail } });
        else if (part._tag === "image_base64")
          parts.push({
            type: "image_url",
            image_url: { url: `data:${part.mediaType};base64,${part.data}` },
          });
      }
      out.push({ role: "user", content: parts });
    }
  }

  return out;
}

function toCompatTools(
  tools: ChatRequest["tools"],
): NonNullable<CompatRequestBody["tools"]> | undefined {
  // §4.8 — Deterministic tool serialisation for prefix stability.
  // Order and field set are identical across calls for the same input;
  // no timestamps or dynamic metadata are added.
  if (!tools) return undefined;
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown,
    },
  }));
}

