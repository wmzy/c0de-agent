// Session service — frontend API client for /api/sessions endpoints.
// Data + functions paradigm: no class, no this.

import type { MessageContentPart } from "../core/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionData = {
  id: string;
  title: string;
  parentId?: string | null;
  branchPoint?: number | null;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type MessageData = {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolCalls?: unknown;
  toolCallId?: string;
  createdAt: Date;
};

// ---------------------------------------------------------------------------
// parseMessageContent — deserialize Message.content from its DB wire format.
//
// The API stores content as a JSON-serialized MessageContentPart[] string.
// This function safely parses it back to the structured array form that
// Message.content expects, falling back to a single text part on failure.
// ---------------------------------------------------------------------------

export function parseMessageContent(content: string): MessageContentPart[] {
  if (!content) return [{ _tag: "text", text: "" }];
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (p): p is MessageContentPart =>
          typeof p === "object" &&
          p !== null &&
          "_tag" in p &&
          typeof (p as Record<string, unknown>)._tag === "string",
      )
    ) {
      return parsed as MessageContentPart[];
    }
  } catch {
    // Not JSON — treat as plain text content.
  }
  return [{ _tag: "text", text: content }];
}

// ---------------------------------------------------------------------------
// listSessions — GET /api/sessions
// ---------------------------------------------------------------------------

export async function listSessions(projectId?: string): Promise<SessionData[]> {
  const url = projectId ? `/api/sessions?projectId=${projectId}` : "/api/sessions";
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to list sessions: ${response.status}`);
  const data = (await response.json()) as unknown[];
  return data.map(deserializeSession);
}

// ---------------------------------------------------------------------------
// createSession — POST /api/sessions
// ---------------------------------------------------------------------------

export async function createSession(title?: string, projectId?: string): Promise<SessionData> {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, projectId }),
  });
  if (!response.ok) throw new Error(`Failed to create session: ${response.status}`);
  return deserializeSession(await response.json());
}

// ---------------------------------------------------------------------------
// deleteSession — DELETE /api/sessions/:id
// ---------------------------------------------------------------------------

export async function deleteSession(id: string): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(`Failed to delete session: ${response.status}`);
}

// ---------------------------------------------------------------------------
// forkSession — POST /api/sessions/:id/fork
// ---------------------------------------------------------------------------

export async function forkSession(
  sessionId: string,
  branchPoint: number,
): Promise<SessionData> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/fork`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branchPoint }),
    },
  );
  if (!response.ok) throw new Error(`Failed to fork session: ${response.status}`);
  return deserializeSession(await response.json());
}

// ---------------------------------------------------------------------------
// getSession — GET /api/sessions/:id
// ---------------------------------------------------------------------------

export async function getSession(id: string): Promise<SessionData | null> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to get session: ${response.status}`);
  return deserializeSession(await response.json());
}

// ---------------------------------------------------------------------------
// getMessages — GET /api/sessions/:id/messages
// ---------------------------------------------------------------------------

export async function getMessages(sessionId: string): Promise<MessageData[]> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
  if (!response.ok) throw new Error(`Failed to get messages: ${response.status}`);
  const data = (await response.json()) as unknown[];
  return data.map(deserializeMessage);
}

// ---------------------------------------------------------------------------
// getMessagesForPreview — fetch last message per session for sidebar preview.
// ---------------------------------------------------------------------------

export async function getMessagesForPreview(
  sessionIds: string[],
): Promise<Record<string, MessageData | null>> {
  const result: Record<string, MessageData | null> = {};

  // Fetch messages for each session in parallel (limited concurrency)
  const batches = sessionIds.map(async (id) => {
    try {
      const msgs = await getMessages(id);
      result[id] = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    } catch {
      result[id] = null;
    }
  });

  await Promise.all(batches);
  return result;
}

// ---------------------------------------------------------------------------
// Deserializers — convert API JSON to typed objects with Date conversion.
// ---------------------------------------------------------------------------

function deserializeSession(raw: unknown): SessionData {
  const obj = raw as Record<string, unknown>;
  return {
    id: String(obj.id ?? ""),
    title: String(obj.title ?? ""),
    parentId: (obj.parentId as string | null) ?? null,
    branchPoint: (obj.branchPoint as number | null) ?? null,
    metadata: (obj.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(String(obj.createdAt ?? new Date().toISOString())),
    updatedAt: new Date(String(obj.updatedAt ?? new Date().toISOString())),
  };
}

function deserializeMessage(raw: unknown): MessageData {
  const obj = raw as Record<string, unknown>;
  return {
    id: String(obj.id ?? ""),
    sessionId: String(obj.sessionId ?? ""),
    role: String(obj.role ?? ""),
    content: String(obj.content ?? ""),
    toolCalls: obj.toolCalls,
    toolCallId: (obj.toolCallId as string) ?? undefined,
    createdAt: new Date(String(obj.createdAt ?? new Date().toISOString())),
  };
}
