// Anthropic Messages API protocol handler (§4 + §4.8).
//
// Implements the ProtocolHandler interface for Anthropic's Messages API.
// Streams SSE, supports extended thinking, and applies prompt caching via
// cache_control breakpoints on system messages and tool definitions.
//
// Includes context window overflow recovery (§4.7 Anthropic): when the
// Anthropic API returns a context-overflow error, the handler automatically
// truncates older messages (keeping the most recent), prepends a summary,
// and retries — up to `maxRetries` times with exponential ratio decay.
//
// Wire format: https://docs.anthropic.com/en/api/messages-streaming

import {
  type ContextRecoveryState,
  type ContextTruncationStrategy,
  DEFAULT_TRUNCATION_STRATEGY,
  adjustMaxTokens,
  compressMessages,
  createRecoveryState,
  recordRecoveryAttempt,
  truncateMessages,
} from "../context-recovery";
import { isContextOverflow } from "../errors";
import {
  chunkDone,
  chunkError,
  chunkText,
  chunkThinking,
  chunkToolCall,
  chunkUsage,
  parseSSE,
} from "../stream";
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

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

type AnthropicConfig = Extract<ProviderConfig, { _tag: "anthropic" }>;

// ---------------------------------------------------------------------------
// Context window overflow recovery (§4.7 Anthropic)
// ---------------------------------------------------------------------------

/**
 * Anthropic-specific context overflow error patterns.
 * Checked in addition to the generic patterns in errors.ts.
 */
const ANTHROPIC_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i,
  /context_length_exceeded/i,
  /overloaded_error/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /maximum number of tokens.*exceeded/i,
  /too many tokens/i,
] as const;

/**
 * Detect Anthropic context overflow from HTTP status + body or an error chunk.
 * Anthropic returns HTTP 400 with an overloaded/overflow message (not 413).
 */
function isAnthropicContextOverflow(
  status: number,
  body: string,
  errorChunk?: StreamChunk & { _tag: "error" },
): boolean {
  if (errorChunk && isContextOverflow(errorChunk)) return true;
  if (status === 400 || status === 413) {
    return ANTHROPIC_OVERFLOW_PATTERNS.some((p) => p.test(body));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Anthropic wire types
// ---------------------------------------------------------------------------

type AnthropicRole = "user" | "assistant";

type AnthropicTextPart = { type: "text"; text: string };
type AnthropicImagePart = {
  type: "image";
  source: { type: "base64" | "url"; media_type?: string; data?: string; url?: string };
};
type AnthropicToolResultPart = {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicContentPart[];
};
type AnthropicContentPart = AnthropicTextPart | AnthropicImagePart | AnthropicToolResultPart;

type AnthropicMessage =
  | { role: "user"; content: string | AnthropicContentPart[] }
  | { role: "assistant"; content: string | AnthropicContentBlock[] };

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "thinking"; thinking: string };

type AnthropicTool = {
  name: string;
  description: string;
  input_schema: unknown;
};

type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  tools?: AnthropicTool[];
  stream: true;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
};

// SSE response event shapes

type MessageStartEvent = {
  type: "message_start";
  message: {
    id: string;
    type: "message";
    role: string;
    content: unknown[];
    model: string;
    stop_reason: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
};

type ContentBlockStartEvent = {
  type: "content_block_start";
  index: number;
  content_block: { type: string; text?: string; name?: string; id?: string; input?: unknown };
};

type ContentBlockDeltaEvent = {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string };
};

type ContentBlockStopEvent = {
  type: "content_block_stop";
  index: number;
};

type MessageDeltaEvent = {
  type: "message_delta";
  delta: { stop_reason: string | null; stop_sequence: string | null };
  usage: { output_tokens: number; cache_read_input_tokens?: number };
};

type MessageStopEvent = {
  type: "message_stop";
};

type PingEvent = { type: "ping" };

type ErrorEvent = {
  type: "error";
  error: { type: string; message: string };
};

type SSEMessageEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | PingEvent
  | ErrorEvent;

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createAnthropicHandler(_config: ProviderConfig): ProtocolHandler {
  return {
    name: "anthropic",
    chat(request: ChatRequest, config: ProviderConfig): AsyncGenerator<StreamChunk> {
      return anthropicChatStreamWithRecovery(request, config as AnthropicConfig);
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming entrypoint (with context-overflow recovery)
// ---------------------------------------------------------------------------

/**
 * Main entry point that performs the HTTP request inline for early context
 * overflow detection.  On 400/413 with an overflow message, truncates
 * messages and retries — streaming the recovery transparently.
 *
 * Keeps the response streamable: on success, chunks are yielded as they
 * arrive (no buffering).  Recovery is triggered only on HTTP-level errors,
 * before any SSE events are emitted.
 */
async function* anthropicChatStreamWithRecovery(
  request: ChatRequest,
  config: AnthropicConfig,
  existingState?: ContextRecoveryState,
): AsyncGenerator<StreamChunk> {
  const state =
    existingState ?? createRecoveryState(DEFAULT_TRUNCATION_STRATEGY, request.messages.length);

  const baseURL = config.baseURL ?? DEFAULT_BASE_URL;

  const { system, messages } = toAnthropicMessages(request);
  const tools = request.tools ? toAnthropicTools(request.tools) : undefined;

  const body: AnthropicRequestBody = {
    model: request.model,
    max_tokens: request.maxTokens ?? 8192,
    messages,
    stream: true,
  };

  // System prompt with prompt caching (§4.8).
  if (system !== undefined) {
    body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }

  if (tools && tools.length > 0) {
    // Apply cache_control breakpoint to last tool for prefix caching (§4.8).
    const cachedTools = tools.map((t, i) =>
      i === tools.length - 1
        ? {
            ...t,
            input_schema: {
              ...(t.input_schema as Record<string, unknown>),
              cache_control: { type: "ephemeral" } as const,
            },
          }
        : t,
    );
    body.tools = cachedTools;
  }

  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.stop !== undefined && request.stop.length > 0) body.stop_sequences = request.stop;

  let response: Response;
  try {
    response = await fetch(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    yield chunkError(err instanceof Error ? err.message : String(err), true, "network");
    return;
  }

  // --- Context overflow detection (HTTP-level, before SSE stream) ---
  if (!response.ok) {
    const text = await response.text().catch(() => "");

    if (isAnthropicContextOverflow(response.status, text)) {
      // Build the error chunk with a canonical code for downstream consumers.
      const overflowError = chunkError(
        `Anthropic ${response.status}: ${text || response.statusText}`,
        false,
        "context_length_exceeded",
      ) as StreamChunk & { _tag: "error" };

      // Attempt progressive truncation recovery.
      if (state.attempt < state.strategy.maxRetries) {
        yield* recoverFromContextOverflow(request, config, overflowError, state);
      } else {
        yield overflowError;
      }
    } else {
      yield chunkError(
        `Anthropic ${response.status}: ${text || response.statusText}`,
        isRetriableStatus(response.status),
        `http_${response.status}`,
      );
    }
    return;
  }

  if (!response.body) {
    yield chunkError("Anthropic returned an empty body", false, "empty_body");
    return;
  }

  // Stream SSE events — no buffering, yield as they arrive.
  yield* streamAnthropicEvents(response.body);
}

// ---------------------------------------------------------------------------
// SSE → StreamChunk (Anthropic Messages streaming)
// ---------------------------------------------------------------------------

async function* streamAnthropicEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamChunk> {
  // Accumulator for tool-call input JSON deltas.
  const toolInputAcc = new Map<number, string>();
  const toolMeta = new Map<number, { id: string; name: string }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let usageEmitted = false;

  for await (const sse of parseSSE(body)) {
    if (!sse.data) continue;

    let event: SSEMessageEvent;
    try {
      event = JSON.parse(sse.data) as SSEMessageEvent;
    } catch {
      continue;
    }

    switch (event.type) {
      case "message_start": {
        const usage = event.message.usage;
        inputTokens = usage.input_tokens;
        outputTokens = usage.output_tokens;
        cacheReadTokens = usage.cache_read_input_tokens ?? 0;
        cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
        break;
      }

      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "tool_use" && block.id && block.name) {
          toolMeta.set(event.index, { id: block.id, name: block.name });
          toolInputAcc.set(event.index, "");
        }
        break;
      }

      case "content_block_delta": {
        switch (event.delta.type) {
          case "text_delta":
            yield chunkText(event.delta.text);
            break;
          case "thinking_delta":
            yield chunkThinking(event.delta.thinking);
            break;
          case "input_json_delta": {
            const existing = toolInputAcc.get(event.index);
            if (existing !== undefined) {
              toolInputAcc.set(event.index, existing + event.delta.partial_json);
            }
            break;
          }
        }
        break;
      }

      case "content_block_stop": {
        // Emit accumulated tool call.
        const meta = toolMeta.get(event.index);
        if (meta) {
          yield chunkToolCall(meta.id, meta.name, toolInputAcc.get(event.index) ?? "{}");
          toolMeta.delete(event.index);
          toolInputAcc.delete(event.index);
        }
        break;
      }

      case "message_delta": {
        const usage = event.usage;
        outputTokens = usage.output_tokens;
        cacheReadTokens = usage.cache_read_input_tokens ?? 0;
        break;
      }

      case "message_stop": {
        if (!usageEmitted && (inputTokens > 0 || outputTokens > 0)) {
          usageEmitted = true;
          yield chunkUsage(
            inputTokens,
            outputTokens,
            cacheReadTokens || undefined,
            cacheWriteTokens || undefined,
          );
        }
        yield chunkDone();
        return;
      }

      case "error": {
        yield chunkError(event.error.message, false, event.error.type);
        return;
      }

      case "ping":
        break;
    }
  }

  // If we reach here without message_stop, yield final chunks.
  if (!usageEmitted && (inputTokens > 0 || outputTokens > 0)) {
    usageEmitted = true;
    yield chunkUsage(
      inputTokens,
      outputTokens,
      cacheReadTokens || undefined,
      cacheWriteTokens || undefined,
    );
  }
  yield chunkDone();
}

// ---------------------------------------------------------------------------
// Message / tool conversion (ChatMessage → Anthropic wire)
// ---------------------------------------------------------------------------

function toAnthropicMessages(request: ChatRequest): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  const systemText =
    request.system ??
    request.messages
      .filter((m) => m.role === "system")
      .map((m) => messageToText(m.content))
      .join("\n\n");

  const messages: AnthropicMessage[] = [];

  for (const message of request.messages) {
    if (message.role === "system") continue;
    messages.push(convertMessage(message));
  }

  // Anthropic requires user/assistant alternation. Merge consecutive same-role.
  const merged = mergeConsecutiveRoles(messages);

  return { system: systemText || undefined, messages: merged };
}

function convertMessage(message: ChatMessage): AnthropicMessage {
  switch (message.role) {
    case "user":
      return { role: "user", content: contentToAnthropic(message.content) };

    case "assistant": {
      // Assistant messages can contain text and tool_use blocks.
      const parts: AnthropicContentBlock[] = [];

      if (typeof message.content === "string" && message.content) {
        parts.push({ type: "text", text: message.content });
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part._tag === "text") {
            parts.push({ type: "text", text: part.text });
          }
        }
      }

      if (message.toolCalls) {
        for (const tc of message.toolCalls) {
          let input: unknown;
          try {
            input = JSON.parse(tc.arguments);
          } catch {
            input = {};
          }
          parts.push({ type: "tool_use", id: tc.id, name: tc.name, input });
        }
      }

      return {
        role: "assistant",
        content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
      };
    }

    case "tool": {
      // Tool results become user messages in Anthropic's format.
      const toolResultPart: AnthropicToolResultPart = {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: messageToText(message.content),
      };
      return { role: "user", content: [toolResultPart] };
    }

    default:
      return { role: "user", content: messageToText(message.content) };
  }
}

function contentToAnthropic(content: string | ContentPart[]): string | AnthropicContentPart[] {
  if (typeof content === "string") return content;
  if (content.length === 0) return "";
  if (content.length === 1 && content[0]._tag === "text") return content[0].text;

  const parts: AnthropicContentPart[] = [];
  for (const part of content) {
    switch (part._tag) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "image_url":
        parts.push({
          type: "image",
          source: { type: "url", url: part.url },
        });
        break;
      case "image_base64":
        parts.push({
          type: "image",
          source: { type: "base64", media_type: part.mediaType, data: part.data },
        });
        break;
      case "document":
        parts.push({
          type: "text",
          text: `[Document: ${part.filename ?? "untitled"} (${part.mediaType})]`,
        });
        break;
      case "audio":
        parts.push({
          type: "text",
          text: `[Audio: ${part.mediaType}]`,
        });
        break;
    }
  }
  return parts;
}

function messageToText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ContentPart, { _tag: "text" }> => p._tag === "text")
    .map((p) => p.text)
    .join("");
}

function toAnthropicTools(tools: ChatTool[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/**
 * Merge consecutive same-role messages — Anthropic requires strict
 * user/assistant alternation.
 */
function mergeConsecutiveRoles(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length === 0) return [];

  const result: AnthropicMessage[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];

    if (prev.role === curr.role) {
      // Merge: concatenate content.
      const prevText =
        typeof prev.content === "string"
          ? prev.content
          : prev.content.map((b) => ("text" in b ? b.text : "")).join("");
      const currText =
        typeof curr.content === "string"
          ? curr.content
          : curr.content.map((b) => ("text" in b ? b.text : "")).join("");
      prev.content = `${prevText}\n\n${currText}`;
    } else {
      result.push(curr);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Context overflow recovery loop
// ---------------------------------------------------------------------------

/**
 * Attempt to recover from a context overflow error by compressing messages,
 * truncating, and retrying.  Yields either the successful stream or the
 * final error.
 *
 * Recovery strategy:
 *   1. Compress messages to reduce token count (strip thinking, collapse
 *      acknowledgments, truncate long text).
 *   2. If still too large, truncate oldest messages with strategy-specific
 *      keep-ratio.
 *   3. On each retry, the keep ratio is exponentially decayed.
 *   4. Dynamically adjust max_tokens to compensate for removed context.
 *   5. A summary of removed messages is prepended to preserve context.
 *   6. After `maxRetries` attempts, yield the original error.
 */
async function* recoverFromContextOverflow(
  request: ChatRequest,
  config: AnthropicConfig,
  errorChunk: StreamChunk & { _tag: "error" },
  recoveryState: ContextRecoveryState,
): AsyncGenerator<StreamChunk> {
  const { strategy } = recoveryState;
  const attemptStart = Date.now();

  // Step 1: Compress messages before truncation (if enabled).
  let workingMessages = request.messages;
  let compressedCount = 0;

  if (strategy.compressBeforeTruncate && workingMessages.length > 0) {
    const cutoffIndex = Math.floor(
      workingMessages.length *
        Math.max(0.1, 1 - strategy.compressRatio * (1 + recoveryState.attempt * 0.3)),
    );
    const compressed = compressMessages(workingMessages, strategy.compressRatio, cutoffIndex);
    workingMessages = compressed.messages;
    compressedCount = compressed.compressedCount;
    recoveryState.totalCompressed += compressedCount;
  }

  // Step 2: Truncate remaining messages (exponential decay of keep ratio).
  const currentRatio = strategy.keepRatio * 0.5 ** recoveryState.attempt;

  const effectiveStrategy: ContextTruncationStrategy = {
    ...strategy,
    keepRatio: Math.max(0.05, currentRatio),
    keepMin: Math.max(1, Math.floor(strategy.keepMin * 0.5)),
  };

  const { messages: truncatedMessages, removedCount } = truncateMessages(
    workingMessages,
    effectiveStrategy,
    strategy.summarize,
  );

  // Nothing to truncate — cannot recover.
  if (removedCount === 0 && compressedCount === 0) {
    yield errorChunk;
    return;
  }

  // Step 3: Update recovery state.
  recoveryState.attempt++;
  recoveryState.lastTruncatedCount = truncatedMessages.length;
  recoveryState.totalRemoved += removedCount;

  // Step 4: Dynamically adjust max_tokens.
  const adjustedMaxTokens = adjustMaxTokens(request.maxTokens ?? 8192, recoveryState);

  // Step 5: Log recovery attempt.
  const durationMs = Date.now() - attemptStart;
  const success = removedCount > 0 || compressedCount > 0;

  console.warn(
    `[anthropic:context_recovery] Attempt ${recoveryState.attempt}/${strategy.maxRetries}: ` +
      `strategy=${strategy.name}, compressed=${compressedCount}, ` +
      `truncated=${removedCount} messages (${truncatedMessages.length} remaining, ` +
      `keepRatio=${currentRatio.toFixed(3)}), ` +
      `maxTokens=${adjustedMaxTokens}`,
  );

  recordRecoveryAttempt(recoveryState, {
    attempt: recoveryState.attempt,
    strategy: strategy.name,
    messagesRemoved: removedCount,
    messagesCompressed: compressedCount,
    keepRatio: currentRatio,
    success: true,
    durationMs,
  });

  const truncatedRequest: ChatRequest = {
    ...request,
    messages: truncatedMessages,
    maxTokens: adjustedMaxTokens,
  };

  // Retry — the wrapper handles HTTP-level detection inline, so recovery
  // of subsequent overflows re-enters this path cleanly.
  yield* anthropicChatStreamWithRecovery(truncatedRequest, config, recoveryState);
}
