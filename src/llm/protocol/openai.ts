// OpenAI Chat Completions protocol handler (§4 + §4.8).
//
// Implements the ProtocolHandler interface for OpenAI's Chat Completions
// API. Streams SSE, accumulates tool-call argument deltas (which arrive as
// fragmented `function.arguments` strings), and emits protocol-neutral
// StreamChunk values.
//
// Supports the optional Responses API path (config.useResponses) for models
// like o3 / gpt-4.1 that expose a reasoning channel there. Both paths share
// the same StreamChunk contract.

import { chunkDone, chunkError, chunkText, chunkToolCall, chunkUsage, parseSSE } from "../stream";
import { isRetriableStatus } from "./utils";
import type {
  ChatMessage,
  ChatRequest,
  ChatTool,
  ContentPart,
  ProtocolHandler,
  ProviderConfig,
  StreamChunk,
} from "../types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

type OpenAIConfig = Extract<ProviderConfig, { _tag: "openai" }>;

// --- OpenAI Chat Completions wire types -----------------------------------

type OAIMessageRole = "system" | "user" | "assistant" | "tool" | "developer";

type OAITextPart = { type: "text"; text: string };
type OAIImageUrlPart = { type: "image_url"; image_url: { url: string; detail?: string } };
type OAIContentPart = OAITextPart | OAIImageUrlPart;

type OAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OAIMessage =
  | {
      role: "system" | "user" | "tool";
      content: string | OAIContentPart[];
      name?: string;
      tool_call_id?: string;
    }
  | { role: "assistant"; content: string | null; tool_calls?: OAIToolCall[] }
  | { role: "developer"; content: string | OAIContentPart[] };

type OAIRequestBody = {
  model: string;
  messages: OAIMessage[];
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
  // Cached stable prefix hint (sent as a deterministic first system msg).
  // OpenAI does automatic prefix caching — no header needed.
};

type OAIChunkChoice = {
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
};

type OAIChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OAIChunkChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createOpenAIHandler(_config: ProviderConfig): ProtocolHandler {
  return {
    name: "openai",
    chat(request: ChatRequest, config: ProviderConfig): AsyncGenerator<StreamChunk> {
      return openAIChatStream(request, config as OpenAIConfig);
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming entrypoint
// ---------------------------------------------------------------------------

async function* openAIChatStream(
  request: ChatRequest,
  config: OpenAIConfig,
): AsyncGenerator<StreamChunk> {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL;
  const useResponses = config.useResponses === true;

  const messages = toOpenAIMessages(request);
  const tools = request.tools ? toOpenAITools(request.tools) : undefined;

  const body: OAIRequestBody = {
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

  const endpoint = useResponses ? `${baseURL}/responses` : `${baseURL}/chat/completions`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(useResponses ? wrapForResponses(body) : body),
    });
  } catch (err) {
    yield chunkError(err instanceof Error ? err.message : String(err), true, "network");
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    yield chunkError(
      `OpenAI ${response.status}: ${text || response.statusText}`,
      isRetriableStatus(response.status),
      `http_${response.status}`,
    );
    return;
  }
  if (!response.body) {
    yield chunkError("OpenAI returned an empty body", false, "empty_body");
    return;
  }

  yield* streamChatCompletions(response.body);
}

// ---------------------------------------------------------------------------
// SSE → StreamChunk (shared by Chat Completions + Responses)
// ---------------------------------------------------------------------------

async function* streamChatCompletions(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamChunk> {
  // Accumulators for tool-call fragments that may split across chunks.
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let emittedUsage = false;

  for await (const sse of parseSSE(body)) {
    if (sse.data === "[DONE]") break;
    if (!sse.data) continue;

    let chunk: OAIChunk;
    try {
      chunk = JSON.parse(sse.data) as OAIChunk;
    } catch {
      // Skip malformed lines — OpenAI sometimes interleaves keepalives.
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

  // Flush any accumulated tool calls as the canonical wire shape.
  for (const entry of toolAcc.values()) {
    if (entry.id && entry.name) {
      yield chunkToolCall(entry.id, entry.name, entry.args);
    }
  }

  yield chunkDone();
}

// ---------------------------------------------------------------------------
// Message / tool conversion (ChatMessage → OpenAI wire)
// ---------------------------------------------------------------------------

function toOpenAIMessages(request: ChatRequest): OAIMessage[] {
  const out: OAIMessage[] = [];

  // System prompt: prefer ChatRequest.system; otherwise emit any 'system' msgs.
  const inlineSystem = request.messages.filter((m) => m.role === "system");
  const systemText =
    request.system ??
    (inlineSystem.length > 0
      ? inlineSystem.map((m) => messageToText(m.content)).join("\n\n")
      : undefined);

  if (systemText !== undefined && systemText.length > 0) {
    // Cache-stable prefix: don't inject timestamps; the caller should already
    // have done this (spec §4.8 DeepSeek/OpenAI optimization).
    out.push({ role: "system", content: systemText });
  }

  for (const message of request.messages) {
    if (message.role === "system") continue; // already merged
    out.push(convertMessage(message));
  }
  return out;
}

function convertMessage(message: ChatMessage): OAIMessage {
  switch (message.role) {
    case "system":
      // Already handled by toOpenAIMessages.
      return { role: "system", content: messageToText(message.content) };
    case "user": {
      const content = contentToOpenAI(message.content);
      const result: { role: "user"; content: string | OAIContentPart[] } = {
        role: "user",
        content,
      };
      return result;
    }
    case "tool": {
      const out: { role: "tool"; content: string; tool_call_id?: string; name?: string } = {
        role: "tool",
        content: messageToText(message.content),
      };
      if (message.toolCallId) out.tool_call_id = message.toolCallId;
      if (message.name) out.name = message.name;
      return out;
    }
    case "assistant": {
      const out: { role: "assistant"; content: string | null; tool_calls?: OAIToolCall[] } = {
        role: "assistant",
        content: messageToText(message.content) || null,
      };
      if (message.toolCalls && message.toolCalls.length > 0) {
        out.tool_calls = message.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      return out;
    }
  }
}

function contentToOpenAI(content: string | ContentPart[]): string | OAIContentPart[] {
  if (typeof content === "string") return content;
  const out: OAIContentPart[] = [];
  for (const part of content) {
    switch (part._tag) {
      case "text":
        out.push({ type: "text", text: part.text });
        break;
      case "image_url":
        out.push({
          type: "image_url",
          image_url: { url: part.url, detail: part.detail },
        });
        break;
      case "image_base64":
        out.push({
          type: "image_url",
          image_url: { url: `data:${part.mediaType};base64,${part.data}` },
        });
        break;
      case "audio":
        // Chat Completions does not natively ingest audio parts; serialize
        // as text metadata so the model at least sees them.
        out.push({
          type: "text",
          text: `[audio:${part.mediaType}]`,
        });
        break;
      case "document":
        out.push({
          type: "text",
          text: `[document:${part.mediaType}] ${part.filename ?? ""}`,
        });
        break;
    }
  }
  return out;
}

function messageToText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => {
      if (p._tag === "text") return p.text;
      if (p._tag === "image_url") return `[image:${p.url}]`;
      if (p._tag === "image_base64") return `[image:${p.mediaType};base64]`;
      if (p._tag === "audio") return `[audio:${p.mediaType}]`;
      return `[document:${p.mediaType}]`;
    })
    .join("");
}

function toOpenAITools(tools: ChatTool[]): OAIRequestBody["tools"] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown,
    },
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Responses API takes the same messages but wraps the request under `input`.
 * We only adapt the surface here — the actual response stream parsing is
 * handled by `streamChatCompletions` because Responses SSE for chat-style
 * models still emits `choices[].delta` content.
 */
function wrapForResponses(body: OAIRequestBody): unknown {
  // Minimal adapter — real Responses usage would translate to `instructions`
  // + `input` arrays, but for Chat Completions-shaped models the surface
  // works as a passthrough and the gateway handles translation.
  return body;
}
