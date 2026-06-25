// Streaming primitives (§4) — convert raw SSE / text-stream bodies into the
// protocol-neutral StreamChunk iterator that protocol handlers wrap.

import type { StreamChunk } from "./types";

/**
 * One Server-Sent Event, as emitted by the protocol handlers.
 *
 * `data` is always a string for OpenAI / Anthropic / Google style SSE; the
 * handlers JSON.parse it as needed.
 */
export type SSEEvent = {
  event?: string;
  data: string;
  id?: string;
};

/**
 * Pull SSE events from a raw byte stream.
 *
 * Decodes the body as UTF-8, splits on the SSE blank-line boundary, and
 * ignores comment lines (starting with `:`). Multi-line `data:` fields are
 * joined with a single newline, mirroring the WHATWG EventSource behavior.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE separates events with a blank line.
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSSEEvent(rawEvent);
        if (event) yield event;
        boundary = buffer.indexOf("\n\n");
      }
    }

    // Flush any trailing event that did not end with a blank line.
    if (buffer.trim().length > 0) {
      const event = parseSSEEvent(buffer);
      if (event) yield event;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released; ignore.
    }
  }
}

function parseSSEEvent(raw: string): SSEEvent | null {
  const lines = raw.split(/\r?\n/);
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      // SSE spec: a single leading space is stripped.
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        data.push(value);
        break;
      case "id":
        id = value;
        break;
      // ignore retry / other fields
    }
  }

  if (data.length === 0 && event === undefined && id === undefined) return null;
  return { event, data: data.join("\n"), id };
}

// ---------------------------------------------------------------------------
// StreamChunk helpers — the protocol-agnostic emission API used by handlers
// ---------------------------------------------------------------------------

/** Yield a text chunk. */
export function chunkText(text: string): StreamChunk {
  return { _tag: "text", text };
}

/** Yield a tool-call delta. */
export function chunkToolCall(id: string, name: string, args: string): StreamChunk {
  return { _tag: "tool_call", id, name, args };
}

/** Yield a thinking/reasoning chunk. */
export function chunkThinking(text: string): StreamChunk {
  return { _tag: "thinking", text };
}

/** Yield a usage chunk. */
export function chunkUsage(
  input: number,
  output: number,
  cacheRead?: number,
  cacheWrite?: number,
): StreamChunk {
  return cacheRead !== undefined || cacheWrite !== undefined
    ? { _tag: "usage", input, output, cacheRead, cacheWrite }
    : { _tag: "usage", input, output };
}

/** Yield a done sentinel. */
export function chunkDone(): StreamChunk {
  return { _tag: "done" };
}

/** Yield an error chunk. */
export function chunkError(message: string, retriable = false, code?: string): StreamChunk {
  return { _tag: "error", message, retriable, code };
}

// ---------------------------------------------------------------------------
// Aggregator — fold a stream into the canonical { text, toolCalls, usage }
// pair so callers that need a final response don't have to reconstruct it
// themselves.
// ---------------------------------------------------------------------------

export type AggregatedResponse = {
  text: string;
  thinking: string;
  toolCalls: Array<{ id: string; name: string; args: string }>;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  error?: { message: string; code?: string; retriable?: boolean };
};

export async function aggregateStream(
  stream: AsyncIterable<StreamChunk>,
): Promise<AggregatedResponse> {
  const acc: AggregatedResponse = {
    text: "",
    thinking: "",
    toolCalls: [],
    usage: { input: 0, output: 0 },
  };

  for await (const chunk of stream) {
    switch (chunk._tag) {
      case "text":
        acc.text += chunk.text;
        break;
      case "thinking":
        acc.thinking += chunk.text;
        break;
      case "tool_call":
        acc.toolCalls.push({ id: chunk.id, name: chunk.name, args: chunk.args });
        break;
      case "usage":
        acc.usage = {
          input: chunk.input,
          output: chunk.output,
          cacheRead: chunk.cacheRead,
          cacheWrite: chunk.cacheWrite,
        };
        break;
      case "error":
        acc.error = { message: chunk.message, code: chunk.code, retriable: chunk.retriable };
        break;
      case "done":
        break;
    }
  }

  return acc;
}
