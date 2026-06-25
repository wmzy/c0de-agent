// Chat service — frontend API client for /api/chat endpoints.
// Data + functions paradigm: no class, no this.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatEvent =
  | { _tag: "text_delta"; text: string }
  | { _tag: "tool_call"; id: string; tool: string; input: unknown }
  | { _tag: "tool_calls_parallel"; calls: Array<{ id: string; tool: string; input: unknown }> }
  | { _tag: "tool_result"; id: string; tool: string; output: unknown }
  | { _tag: "thinking"; text: string }
  | { _tag: "usage"; input: number; output: number }
  | { _tag: "permission_required"; toolCallId: string; tool: string; input: unknown }
  | { _tag: "error"; error: unknown }
  | { _tag: "done" }
  | { _tag: "warning"; message: string }
  | { _tag: "think_mode_switch"; from: string; to: string; model: string }
  | { _tag: "thinking_classified"; classification: string };

// ---------------------------------------------------------------------------
// sendChatMessage — POST /api/chat, streams SSE events via callback.
// Returns an AbortController so the caller can cancel the stream.
// ---------------------------------------------------------------------------

export function sendChatMessage(
  sessionId: string,
  message: string,
  onEvent: (event: ChatEvent) => void,
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "Unknown error");
        onEvent({ _tag: "error", error: new Error(`Chat request failed (${response.status}): ${text}`) });
        return;
      }

      for await (const event of parseSSEStream(response)) {
        onEvent(event);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onEvent({ _tag: "error", error: err });
      }
    }
  })();

  return controller;
}

// ---------------------------------------------------------------------------
// abortChat — POST /api/chat/abort
// ---------------------------------------------------------------------------

export async function abortChat(sessionId: string): Promise<void> {
  const response = await fetch("/api/chat/abort", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });

  if (!response.ok && response.status !== 404) {
    console.warn(`Failed to abort chat for session ${sessionId}: ${response.status}`);
  }
}

// ---------------------------------------------------------------------------
// confirmTool — POST /api/tools/confirm
// ---------------------------------------------------------------------------

export async function confirmTool(
  toolCallId: string,
  confirmed: boolean,
): Promise<void> {
  const response = await fetch("/api/tools/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toolCallId, confirmed }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    throw new Error(`Tool confirmation failed (${response.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// parseSSEStream — Parse a fetch Response body as SSE events.
// ---------------------------------------------------------------------------

export async function* parseSSEStream(
  response: Response,
): AsyncGenerator<ChatEvent> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE messages (separated by \n\n)
      const messages = buffer.split("\n\n");
      buffer = messages.pop() ?? "";

      for (const msg of messages) {
        if (!msg.trim()) continue;

        let eventType = "";
        let data = "";

        for (const line of msg.split("\n")) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
          } else if (line.startsWith("data: ")) {
            data = line.slice(6);
          }
        }

        if (!eventType || !data) continue;

        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          const event = sseDataToChatEvent(eventType, parsed);
          if (event) yield event;
        } catch {
          // Skip malformed JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// sseDataToChatEvent — Map SSE event type + data to ChatEvent.
// ---------------------------------------------------------------------------

function sseDataToChatEvent(
  type: string,
  data: Record<string, unknown>,
): ChatEvent | null {
  switch (type) {
    case "text_delta":
      return { _tag: "text_delta", text: String(data.text ?? "") };
    case "tool_call":
      return {
        _tag: "tool_call",
        id: String(data.id ?? ""),
        tool: String(data.tool ?? ""),
        input: data.input,
      };
    case "tool_calls_parallel":
      return {
        _tag: "tool_calls_parallel",
        calls: Array.isArray(data.calls)
          ? data.calls.map((c: unknown) => {
              const call = c as Record<string, unknown>;
              return {
                id: String(call.id ?? ""),
                tool: String(call.tool ?? ""),
                input: call.input,
              };
            })
          : [],
      };
    case "tool_result":
      return {
        _tag: "tool_result",
        id: String(data.id ?? ""),
        tool: String(data.tool ?? ""),
        output: data.output,
      };
    case "thinking":
      return { _tag: "thinking", text: String(data.text ?? "") };
    case "usage":
      return {
        _tag: "usage",
        input: Number(data.input ?? 0),
        output: Number(data.output ?? 0),
      };
    case "permission_required":
      return {
        _tag: "permission_required",
        toolCallId: String(data.toolCallId ?? ""),
        tool: String(data.tool ?? ""),
        input: data.input,
      };
    case "error":
      return { _tag: "error", error: data.error };
    case "done":
      return { _tag: "done" };
    case "warning":
      return { _tag: "warning", message: String(data.message ?? "") };
    case "think_mode_switch":
      return {
        _tag: "think_mode_switch",
        from: String(data.from ?? ""),
        to: String(data.to ?? ""),
        model: String(data.model ?? ""),
      };
    case "thinking_classified":
      return {
        _tag: "thinking_classified",
        classification: String(data.classification ?? ""),
      };
    default:
      return null;
  }
}
