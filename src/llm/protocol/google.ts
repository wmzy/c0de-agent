// Google Gemini API protocol handler (§4).
//
// Implements the ProtocolHandler interface for Google's Gemini API.
// Uses REST API with streaming via streamGenerateContent, and supports
// multimodal input (text, images, documents).
//
// Wire format: https://ai.google.dev/api/generate-content

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

// ---------------------------------------------------------------------------
// Context Caching (§4.8)
// ---------------------------------------------------------------------------

/** Default TTL for cached content in seconds. */
const CACHE_TTL_SECONDS = 3600;

/** Module-level state: cached content entries keyed by model name. */
type CachedContentEntry = {
  /** The resource name returned by the API, e.g. "cachedContents/abc123". */
  name: string;
  /** Hash of the system instruction used to create this cache. */
  systemHash: string;
  /** Hash of the serialized tools used to create this cache. */
  toolsHash: string;
  /** Epoch ms when this cache entry expires. */
  expiresAt: number;
};

/** Per-model cache store. A single model can hold one active cache. */
const cachedContentStore = new Map<string, CachedContentEntry>();

/**
 * Deterministic hash for cache-key computation.
 * Uses a simple FNV-1a variant — collision-tolerant but fast;
 * the Google API itself deduplicates identical cached content.
 */
function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash).toString(36);
}

type GeminiCachedContentResponse = {
  name: string;
  model: string;
  displayName?: string;
  systemInstruction?: GeminiSystemInstruction;
  tools?: GeminiTool[];
  createTime?: string;
  updateTime?: string;
  expireTime?: string;
  usageMetadata?: {
    cachedContentTokenCount: number;
  };
};

/**
 * Create a Google Context Cache via the Gemini API.
 *
 * Endpoint: POST /v1beta/models/{model}:createCachedContent
 *
 * @returns The cache resource name (e.g. "cachedContents/…") or null on failure.
 */
async function createGeminiCachedContent(
  baseURL: string,
  apiKey: string,
  model: string,
  systemInstruction?: GeminiSystemInstruction,
  tools?: GeminiTool[],
): Promise<string | null> {
  const endpoint = `${baseURL}/v1beta/models/${model}:createCachedContent?key=${apiKey}`;

  const body: Record<string, unknown> = {
    model: `models/${model}`,
    ttl: `${CACHE_TTL_SECONDS}s`,
  };

  if (systemInstruction) {
    body.systemInstruction = systemInstruction;
  }
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as GeminiCachedContentResponse;
    return data.name;
  } catch {
    return null;
  }
}

/**
 * Resolve or create a cached content for the given model + system + tools.
 *
 * Returns the cache resource name, or `null` if caching is not applicable
 * (e.g. no system instruction and no tools — nothing to cache).
 */
async function resolveCachedContent(
  baseURL: string,
  apiKey: string,
  model: string,
  systemInstruction?: GeminiSystemInstruction,
  tools?: GeminiTool[],
): Promise<string | null> {
  // Compute deterministic hashes for the cache key components.
  const sysHash = systemInstruction ? stableHash(JSON.stringify(systemInstruction)) : "_none";
  const toolsHash = tools && tools.length > 0 ? stableHash(JSON.stringify(tools)) : "_none";

  // There is nothing meaningful to cache.
  if (sysHash === "_none" && toolsHash === "_none") {
    return null;
  }

  const now = Date.now();
  const existing = cachedContentStore.get(model);

  // Reuse if hashes match and the cache hasn't expired.
  if (
    existing &&
    existing.systemHash === sysHash &&
    existing.toolsHash === toolsHash &&
    existing.expiresAt > now
  ) {
    return existing.name;
  }

  // Create a new cached content.
  const name = await createGeminiCachedContent(baseURL, apiKey, model, systemInstruction, tools);

  if (!name) return null;

  cachedContentStore.set(model, {
    name,
    systemHash: sysHash,
    toolsHash: toolsHash,
    expiresAt: now + CACHE_TTL_SECONDS * 1000,
  });

  return name;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

type GoogleConfig = Extract<ProviderConfig, { _tag: "google" }>;

// ---------------------------------------------------------------------------
// Google Gemini wire types
// ---------------------------------------------------------------------------

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

type GeminiTool = {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  }>;
};

type GeminiGenerationConfig = {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  responseMimeType?: string;
};

type GeminiSystemInstruction = {
  parts: GeminiPart[];
};

type GeminiRequestBody = {
  contents: GeminiContent[];
  systemInstruction?: GeminiSystemInstruction;
  tools?: GeminiTool[];
  generationConfig?: GeminiGenerationConfig;
  /** Reference to a cached content resource (§4.8 Context Caching). */
  cachedContent?: string;
};

type GeminiStreamChunk = {
  candidates?: Array<{
    content: { parts: GeminiPart[]; role: string };
    finishReason?: string;
    index: number;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    /** Tokens served from Context Cache (§4.8). */
    cachedContentTokenCount?: number;
  };
};

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createGoogleHandler(_config: ProviderConfig): ProtocolHandler {
  return {
    name: "google",
    chat(request: ChatRequest, config: ProviderConfig): AsyncGenerator<StreamChunk> {
      return googleChatStream(request, config as GoogleConfig);
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming entrypoint
// ---------------------------------------------------------------------------

async function* googleChatStream(
  request: ChatRequest,
  config: GoogleConfig,
): AsyncGenerator<StreamChunk> {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL;

  const { systemInstruction, contents } = toGeminiContents(request);
  const tools = request.tools ? toGeminiTools(request.tools) : undefined;

  const body: GeminiRequestBody = {
    contents,
  };

  // -----------------------------------------------------------------------
  // Context Caching (§4.8)
  // When preferCacheStable is set, try to create or reuse a cached content
  // that holds the system prompt + tools. The API then reuses the cached
  // tokens for the lifetime of the cache (TTL = 3600 s).
  // -----------------------------------------------------------------------
  if (request.preferCacheStable) {
    const cacheName = await resolveCachedContent(
      baseURL,
      config.apiKey,
      request.model,
      systemInstruction,
      tools,
    );

    if (cacheName) {
      body.cachedContent = cacheName;
      // systemInstruction and tools come from the cache — omit from body.
    }
  }

  // When NOT using cache, include system instruction and tools normally.
  if (!body.cachedContent) {
    if (systemInstruction !== undefined) {
      body.systemInstruction = systemInstruction;
    }
    if (tools) {
      body.tools = tools;
    }
  }

  const genConfig: GeminiGenerationConfig = {};
  if (request.maxTokens !== undefined) genConfig.maxOutputTokens = request.maxTokens;
  if (request.temperature !== undefined) genConfig.temperature = request.temperature;
  if (request.topP !== undefined) genConfig.topP = request.topP;
  if (request.stop !== undefined && request.stop.length > 0) genConfig.stopSequences = request.stop;
  if (Object.keys(genConfig).length > 0) {
    body.generationConfig = genConfig;
  }

  // Use streamGenerateContent with SSE (alt=sse).
  const endpoint = `${baseURL}/v1beta/models/${request.model}:streamGenerateContent?alt=sse&key=${config.apiKey}`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    yield chunkError(err instanceof Error ? err.message : String(err), true, "network");
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    yield chunkError(
      `Google ${response.status}: ${text || response.statusText}`,
      isRetriableStatus(response.status),
      `http_${response.status}`,
    );
    return;
  }

  if (!response.body) {
    yield chunkError("Google returned an empty body", false, "empty_body");
    return;
  }

  yield* streamGeminiChunks(response.body);
}

// ---------------------------------------------------------------------------
// SSE → StreamChunk (Gemini streaming)
// ---------------------------------------------------------------------------

async function* streamGeminiChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let usageEmitted = false;

  for await (const sse of parseSSE(body)) {
    if (!sse.data) continue;

    let chunk: GeminiStreamChunk;
    try {
      chunk = JSON.parse(sse.data) as GeminiStreamChunk;
    } catch {
      continue;
    }

    // Process candidates.
    if (chunk.candidates) {
      for (const candidate of chunk.candidates) {
        const parts = candidate.content?.parts;
        if (!parts) continue;

        for (const part of parts) {
          if ("text" in part) {
            yield chunkText(part.text);
          } else if ("functionCall" in part) {
            // Google returns complete tool calls (not deltas), so emit them
            // with a generated id.
            const toolId = `google_${candidate.index}_${part.functionCall.name}`;
            yield chunkToolCall(
              toolId,
              part.functionCall.name,
              JSON.stringify(part.functionCall.args),
            );
          }
        }
      }
    }

    // Accumulate usage.
    if (chunk.usageMetadata) {
      inputTokens = chunk.usageMetadata.promptTokenCount;
      outputTokens = chunk.usageMetadata.candidatesTokenCount;
      if (chunk.usageMetadata.cachedContentTokenCount) {
        cacheReadTokens = chunk.usageMetadata.cachedContentTokenCount;
      }
    }
  }

  if (!usageEmitted && (inputTokens > 0 || outputTokens > 0)) {
    usageEmitted = true;
    yield chunkUsage(inputTokens, outputTokens, cacheReadTokens || undefined);
  }
  yield chunkDone();
}

// ---------------------------------------------------------------------------
// Message / tool conversion (ChatMessage → Gemini wire)
// ---------------------------------------------------------------------------

function toGeminiContents(request: ChatRequest): {
  systemInstruction: GeminiSystemInstruction | undefined;
  contents: GeminiContent[];
} {
  const systemText =
    request.system ??
    request.messages
      .filter((m) => m.role === "system")
      .map((m) => messageToText(m.content))
      .join("\n\n");

  const contents: GeminiContent[] = [];

  for (const message of request.messages) {
    if (message.role === "system") continue;

    const converted = convertMessage(message);
    if (converted) {
      // Merge with previous if same role.
      const last = contents[contents.length - 1];
      if (last && last.role === converted.role) {
        last.parts.push(...converted.parts);
      } else {
        contents.push(converted);
      }
    }
  }

  return {
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    contents,
  };
}

function convertMessage(message: ChatMessage): GeminiContent | null {
  switch (message.role) {
    case "user":
      return { role: "user", parts: contentToGeminiParts(message.content) };

    case "assistant": {
      const parts: GeminiPart[] = [];

      if (typeof message.content === "string" && message.content) {
        parts.push({ text: message.content });
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part._tag === "text") {
            parts.push({ text: part.text });
          }
        }
      }

      if (message.toolCalls) {
        for (const tc of message.toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.arguments) as Record<string, unknown>;
          } catch {
            // Parse failure — send empty args.
          }
          parts.push({ functionCall: { name: tc.name, args } });
        }
      }

      return parts.length > 0 ? { role: "model", parts } : null;
    }

    case "tool": {
      let responseData: Record<string, unknown> = {};
      try {
        responseData = { result: messageToText(message.content) };
      } catch {
        responseData = { result: "" };
      }
      return {
        role: "user",
        parts: [{ functionResponse: { name: message.name ?? "unknown", response: responseData } }],
      };
    }

    default:
      return { role: "user", parts: [{ text: messageToText(message.content) }] };
  }
}

function contentToGeminiParts(content: string | ContentPart[]): GeminiPart[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }

  const parts: GeminiPart[] = [];
  for (const part of content) {
    switch (part._tag) {
      case "text":
        parts.push({ text: part.text });
        break;
      case "image_url":
        parts.push({
          inlineData: {
            mimeType: "image/jpeg",
            data: `url:${part.url}`,
          },
        });
        break;
      case "image_base64":
        parts.push({
          inlineData: {
            mimeType: part.mediaType,
            data: part.data,
          },
        });
        break;
      case "document":
        parts.push({
          fileData: {
            mimeType: part.mediaType,
            fileUri: `data:application/octet-stream;base64,${part.data}`,
          },
        });
        break;
      case "audio":
        parts.push({
          inlineData: {
            mimeType: part.mediaType,
            data: part.data,
          },
        });
        break;
    }
  }

  return parts.length > 0 ? parts : [{ text: "" }];
}

function messageToText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ContentPart, { _tag: "text" }> => p._tag === "text")
    .map((p) => p.text)
    .join("");
}

function toGeminiTools(tools: ChatTool[]): GeminiTool[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      })),
    },
  ];
}

