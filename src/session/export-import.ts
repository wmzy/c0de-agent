// Session export/import — inspired by OpenCode's session management.
//
// Data + functions: no class, no this. Pure transformations from DB rows to
// portable formats and back.
//
// Supported export formats:
//   "json"     — structured JSON with format version marker, suitable for
//                programmatic round-trips and cross-tool migration.
//   "markdown" — human-readable Markdown transcript, suitable for sharing
//                in chat, documentation, or review.
//
// Supported import sources:
//   "c0de-agent" — native JSON export from this tool.
//   "openai"     — OpenAI fine-tuning format: {"messages": [...]} per line
//                  or array of such objects.
//   "chatgpt"    — ChatGPT conversation export (conversations.json).
//   "claude"     — Anthropic Claude conversation export format.
//   "auto"       — detect format from data content (default).

import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { messages, sessions } from "../db/schema";
import type { Session, SessionMetadata } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Export serialization format. "json" for round-trip, "markdown" for humans, "html" for styled web page. */
export type ExportFormat = "json" | "markdown" | "html";

/** MIME type for each export format. */
export const EXPORT_MIME: Record<ExportFormat, string> = {
  json: "application/json",
  markdown: "text/markdown",
  html: "text/html",
};

/** Import source format. "auto" sniff from content. */
export type ImportFormat = "c0de-agent" | "openai" | "chatgpt" | "claude" | "auto";

/** Options controlling export behavior. */
export type ExportOptions = {
  /** Include messages in export (default true). */
  includeMessages?: boolean;
  /** Optional custom title override in the export metadata. */
  title?: string;
  /** Additional metadata to merge into export. */
  extraMeta?: Record<string, unknown>;
};

/** Options controlling import behavior. */
export type ImportOptions = {
  /** Source format; "auto" detects from content. */
  format?: ImportFormat;
  /** Override title for the imported session. */
  title?: string;
  /** When true, skip duplicate detection (default false). */
  force?: boolean;
};

/** Result of a single batch export entry. */
export type BatchExportEntry = {
  sessionId: string;
  data: Buffer;
  format: ExportFormat;
};

/** Result of a single batch import entry. */
export type BatchImportEntry = {
  session: Session;
  warnings?: string[];
};

// ---------------------------------------------------------------------------
// Canonical export schema (v1)
// ---------------------------------------------------------------------------

/**
 * Versioned export envelope. formatVersion allows forward-compatible schema
 * evolution. Every export carries the tool name, export timestamp, session
 * metadata, and an ordered list of messages (with ids stripped to avoid
 * collisions on re-import — the import side issues fresh UUIDs).
 */
export type ExportedSessionV1 = {
  formatVersion: 1;
  tool: "c0de-agent";
  exportedAt: string;
  session: {
    id: string;
    title: string;
    parentId: string | null;
    branchPoint: number | null;
    metadata: SessionMetadata;
    createdAt: string;
    updatedAt: string;
  };
  messages: Array<{
    role: string;
    content: unknown;
    tokenCount: number;
    createdAt: string;
  }>;
};

// ---------------------------------------------------------------------------
// Canonical import message — intermediate representation before DB insertion.
// Every external format is normalised into this shape.
// ---------------------------------------------------------------------------

type ImportMessage = {
  role: string;
  content: unknown;
  createdAt?: Date;
};

type CanonicalImport = {
  title: string;
  messages: ImportMessage[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoNow(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// exportSession — single session export
// ---------------------------------------------------------------------------

/**
 * Export a single session to the requested format.
 *
 * @param db       Database handle
 * @param sessionId  Session ID to export
 * @param format   "json" (structured) or "markdown" (readable transcript)
 * @param opts     Optional export configuration
 * @returns Node.js Buffer with the exported content
 *
 * @throws if the session does not exist
 */
export async function exportSession(
  db: DB,
  sessionId: string,
  format: ExportFormat = "json",
  opts?: ExportOptions,
): Promise<Buffer> {
  // 1. Fetch session row.
  const [sessionRow] = await db.db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!sessionRow) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // 2. Fetch messages (unless suppressed).
  const msgRows = opts?.includeMessages === false
    ? []
    : await db.db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(messages.createdAt);

  // 3. Serialize.
  switch (format) {
    case "json":
      return serializeJSON(sessionRow, msgRows, opts);
    case "markdown":
      return serializeMarkdown(sessionRow, msgRows, opts);
    case "html":
      return serializeHTML(sessionRow, msgRows, opts);
  }
}

// ---------------------------------------------------------------------------
// exportSessions — batch export
// ---------------------------------------------------------------------------

/**
 * Export multiple sessions at once. Each session is exported independently;
 * the caller receives an array of { sessionId, data, format } entries.
 *
 * @param db          Database handle
 * @param sessionIds  Array of session IDs to export
 * @param format      Export format (applied to all)
 * @param opts        Optional export config (applied to all)
 * @returns Array of batch export entries
 */
export async function exportSessions(
  db: DB,
  sessionIds: string[],
  format: ExportFormat = "json",
  opts?: ExportOptions,
): Promise<BatchExportEntry[]> {
  const results: BatchExportEntry[] = [];

  for (const id of sessionIds) {
    const data = await exportSession(db, id, format, opts);
    results.push({ sessionId: id, data, format });
  }

  return results;
}

// ---------------------------------------------------------------------------
// importSession — single session import
// ---------------------------------------------------------------------------

/**
 * Import a session from exported data.
 *
 * Creates a new session in the DB and inserts all messages. The source
 * can be a native c0de-agent export or a foreign format (OpenAI, ChatGPT,
 * Claude). Foreign formats are parsed into a canonical message list and
 * stored with auto-detected roles.
 *
 * @param db     Database handle
 * @param data   Exported data (Buffer or string)
 * @param opts   Import options (format, title override)
 * @returns The newly created Session (agent-loop type)
 */
export async function importSession(
  db: DB,
  data: Buffer | string,
  opts?: ImportOptions,
): Promise<Session> {
  const importFormat = opts?.format ?? "auto";
  const resolvedFormat = importFormat === "auto"
    ? detectImportFormat(data)
    : importFormat;

  // 1. Parse into canonical representation.
  const canonical = await parseToCanonical(data, resolvedFormat);

  // 2. Create the session row.
  const title = opts?.title ?? canonical.title;
  const now = new Date();
  const [newSession] = await db.db
    .insert(sessions)
    .values({
      id: crypto.randomUUID(),
      title,
      parentId: null,
      branchPoint: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  // 3. Insert messages.
  const sessionId = newSession.id;
  for (const msg of canonical.messages) {
    await db.db
      .insert(messages)
      .values({
        id: crypto.randomUUID(),
        sessionId,
        role: normalizeRole(msg.role),
        content: (msg.content as unknown as Record<string, unknown>) ?? "{}",
        tokenCount: 0,
        createdAt: msg.createdAt ?? now,
      })
      .returning();
  }

    // 4. Touch session updatedAt to match last message time.
  const lastMsgDate = canonical.messages.length > 0
    ? (canonical.messages[canonical.messages.length - 1].createdAt ?? now)
    : now;
  await db.db
    .update(sessions)
    .set({ updatedAt: lastMsgDate })
    .where(eq(sessions.id, sessionId));

  // 5. Return as Session type (number timestamps, no parent/branch).
  return {
    id: sessionId,
    title,
    parentId: null,
    branchPoint: null,
    metadata: {},
    createdAt: now.getTime(),
    updatedAt: lastMsgDate.getTime(),
  } as Session;
}

// ---------------------------------------------------------------------------
// importSessions — batch import
// ---------------------------------------------------------------------------

/**
 * Import multiple sessions in one call.
 *
 * Each data item is imported independently. Warnings (e.g. unrecognized
 * messages, truncated content) are collected per entry.
 *
 * @param db        Database handle
 * @param dataArray Array of exported data buffers/strings
 * @param opts      Import options (applied to each entry)
 * @returns Array of batch import results with session + optional warnings
 */
export async function importSessions(
  db: DB,
  dataArray: (Buffer | string)[],
  opts?: ImportOptions,
): Promise<BatchImportEntry[]> {
  const results: BatchImportEntry[] = [];

  for (const data of dataArray) {
    const session = await importSession(db, data, opts);
    results.push({ session });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/**
 * Detect the import format from the raw data content.
 * Examines structure rather than relying on file extensions.
 */
export function detectImportFormat(data: Buffer | string): ImportFormat {
  const text = typeof data === "string" ? data : data.toString("utf-8");
  const trimmed = text.trim();

  // Empty → assume native.
  if (trimmed.length === 0) return "c0de-agent";

  // Try parsing as JSON.
  try {
    const parsed = JSON.parse(trimmed);

    // Native format: has formatVersion and tool === "c0de-agent".
    if (isRecord(parsed) && "formatVersion" in parsed && parsed.tool === "c0de-agent") {
      return "c0de-agent";
    }

    // ChatGPT export: array or object with "conversations" key.
    if (Array.isArray(parsed)) {
      // Check first element for ChatGPT conversation shape.
      if (parsed.length > 0 && isRecord(parsed[0]) && "conversation_id" in parsed[0]) {
        return "chatgpt";
      }
      // Array of OpenAI messages objects.
      if (parsed.length > 0 && isRecord(parsed[0]) && "messages" in parsed[0]) {
        return "openai";
      }
    }
    if (isRecord(parsed) && "conversations" in parsed) {
      return "chatgpt";
    }

    // OpenAI format: single {"messages": [...]} object.
    if (isRecord(parsed) && "messages" in parsed) {
      return "openai";
    }

    // Claude format: has "chat_messages" key.
    if (isRecord(parsed) && "chat_messages" in parsed) {
      return "claude";
    }

    // Object with "session" property → native.
    if (isRecord(parsed) && "session" in parsed) {
      return "c0de-agent";
    }

    // NL-separated JSON objects → could be OpenAI JSONL.
    if (trimmed.includes("\n")) {
      const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
      const jsonObjects = lines.filter((l) => {
        try { JSON.parse(l); return true; } catch { return false; }
      });
      if (jsonObjects.length === lines.length && jsonObjects.length > 0) {
        return "openai";
      }
    }
  } catch {
    // Not JSON. Check for markdown-style session header.
    if (/^# Session:/m.test(trimmed)) {
      return "c0de-agent";
    }
  }

  // Fallback: attempt native markdown import.
  return "c0de-agent";
}

// ---------------------------------------------------------------------------
// Parsers — external format → canonical import shape
// ---------------------------------------------------------------------------

/**
 * Parse raw data of a known format into a canonical import representation.
 */
async function parseToCanonical(
  data: Buffer | string,
  format: ImportFormat,
): Promise<CanonicalImport> {
  const text = typeof data === "string" ? data : data.toString("utf-8");

  switch (format) {
    case "c0de-agent":
      return parseNative(text);
    case "openai":
      return parseOpenAI(text);
    case "chatgpt":
      return parseChatGPT(text);
    case "claude":
      return parseClaude(text);
    default:
      throw new Error(`Unsupported import format: ${format}`);
  }
}

/** Parse native c0de-agent export (JSON or markdown). */
function parseNative(text: string): CanonicalImport {
  const trimmed = text.trim();

  // Try JSON first.
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed) && "session" in parsed && isRecord(parsed.session)) {
      const v1 = parsed as unknown as ExportedSessionV1;
      return {
        title: v1.session.title,
        messages: v1.messages.map((m) => ({
          role: m.role,
          content: m.content,
          createdAt: new Date(m.createdAt),
        })),
      };
    }
    // Inline session object (partial export).
    if (isRecord(parsed) && "title" in parsed && "messages" in parsed) {
      const msgs = parsed.messages as Array<{ role: string; content: unknown; createdAt?: string }>;
      return {
        title: String(parsed.title),
        messages: msgs.map((m) => ({
          role: m.role,
          content: m.content,
          createdAt: m.createdAt ? new Date(m.createdAt) : undefined,
        })),
      };
    }
  } catch {
    // Fall through to markdown parser.
  }

  // Markdown format.
  return parseNativeMarkdown(trimmed);
}

/** Parse markdown transcript format. */
function parseNativeMarkdown(text: string): CanonicalImport {
  const lines = text.split("\n");
  let title = "Imported Session";
  const messagesList: ImportMessage[] = [];

  // Extract title from first # heading.
  const titleMatch = text.match(/^# Session:\s*(.+)$/m);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  // Extract messages from ## Messages section.
  // Each block starts with ### <role> optionally followed by (timestamp).
  let currentRole = "";
  let currentContent: string[] = [];

  function flushMessage() {
    if (currentRole && currentContent.length > 0) {
      messagesList.push({
        role: currentRole,
        content: currentContent.join("\n").trim(),
      });
      currentContent = [];
    }
  }

  for (const line of lines) {
    const headerMatch = line.match(/^###\s+(.+?)(?:\s*\(([^)]+)\))?\s*$/);
    if (headerMatch) {
      flushMessage();
      currentRole = headerMatch[1].trim().toLowerCase();
      continue;
    }
    currentContent.push(line);
  }
  flushMessage();

  return { title, messages: messagesList };
}

/** Parse OpenAI fine-tuning format. */
function parseOpenAI(text: string): CanonicalImport {
  const trimmed = text.trim();
  let conversations: Array<{ messages: Array<{ role: string; content: string }> }> = [];

  // Try as JSONL (one JSON object per line).
  if (trimmed.includes("\n")) {
    const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
    const allObjects = lines.every((l) => {
      try { JSON.parse(l); return true; } catch { return false; }
    });
    if (allObjects) {
      conversations = lines.map((l) => JSON.parse(l));
    }
  }

  // Try as JSON array.
  if (conversations.length === 0) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        conversations = parsed as Array<{ messages: Array<{ role: string; content: string }> }>;
      } else if (isRecord(parsed) && "messages" in parsed) {
        conversations = [parsed as { messages: Array<{ role: string; content: string }> }];
      }
    } catch {
      // Ignore parse errors.
    }
  }

  if (conversations.length === 0) {
    throw new Error("Could not parse OpenAI format: no valid message objects found");
  }

  // Use the first conversation.
  const conv = conversations[0];
  const messagesList: ImportMessage[] = (conv.messages ?? []).map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }));

  return {
    title: `Imported ${conv.messages?.length ?? 0} messages (OpenAI)`,
    messages: messagesList,
  };
}

/** Parse ChatGPT conversation export. */
function parseChatGPT(text: string): CanonicalImport {
  const trimmed = text.trim();
  let conversations: Array<Record<string, unknown>> = [];

  try {
    const parsed = JSON.parse(trimmed);

    if (Array.isArray(parsed)) {
      conversations = parsed;
    } else if (isRecord(parsed) && "conversations" in parsed && Array.isArray(parsed.conversations)) {
      conversations = parsed.conversations as Array<Record<string, unknown>>;
    }
  } catch {
    throw new Error("Could not parse ChatGPT export: invalid JSON");
  }

  if (conversations.length === 0) {
    throw new Error("Could not parse ChatGPT export: no conversations found");
  }

  // Use the first conversation.
  const conv = conversations[0];
  const title = String(conv.title ?? conv.name ?? "Imported ChatGPT Conversation");
  const mapping = isRecord(conv.mapping) ? conv.mapping : {};

  // ChatGPT export has a node-based mapping structure.
  const messagesList: ImportMessage[] = [];
  for (const node of Object.values(mapping)) {
    if (isRecord(node)) {
      const msg = isRecord(node.message) ? node.message : null;
      if (msg && typeof msg.author === "object" && msg.author !== null) {
        const author = msg.author as Record<string, unknown>;
        const role = String(author.role ?? "user");
        const content = msg.content as Record<string, unknown> | undefined;
        let text = "";
        if (content) {
          if (Array.isArray(content.parts)) {
            text = content.parts.map((p: unknown) => typeof p === "string" ? p : JSON.stringify(p)).join("\n");
          } else if (typeof content.text === "string") {
            text = content.text;
          }
        }

        // Only add non-empty messages with valid roles.
        const validRole = normalizeRole(role);
        if (text.trim().length > 0) {
          messagesList.push({ role: validRole, content: text.trim() });
        }
      }
    }
  }

  return {
    title,
    messages: messagesList,
  };
}

/** Parse Claude/Anthropic conversation export. */
function parseClaude(text: string): CanonicalImport {
  const trimmed = text.trim();
  let conversations: Array<Record<string, unknown>> = [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      conversations = parsed;
    } else if (isRecord(parsed)) {
      // Single conversation object.
      conversations = [parsed];
    }
  } catch {
    throw new Error("Could not parse Claude export: invalid JSON");
  }

  if (conversations.length === 0) {
    throw new Error("Could not parse Claude export: no conversations found");
  }

  // Use the first conversation.
  const conv = conversations[0];
  const name = String(conv.name ?? conv.title ?? "Imported Claude Conversation");
  const chatMessages = isRecord(conv.chat_messages)
    ? Object.values(conv.chat_messages)
    : Array.isArray(conv.chat_messages)
      ? conv.chat_messages
      : [];

  const messagesList: ImportMessage[] = (chatMessages as Array<Record<string, unknown>>)
    .filter((m) => typeof m.sender === "string")
    .map((m) => ({
      role: normalizeClaudeRole(String(m.sender)),
      content: extractClaudeContent(m),
      createdAt: m.created_at ? new Date(String(m.created_at)) : undefined,
    }));

  return {
    title: name,
    messages: messagesList,
  };
}

/** Extract text content from a Claude message (handles text + tool_use blocks). */
function extractClaudeContent(msg: Record<string, unknown>): string {
  const text = msg.text;
  if (typeof text === "string" && text.length > 0) return text;

  // Claude may nest content in "content" array (text blocks, tool_use blocks).
  const content = msg.content;
  if (Array.isArray(content)) {
    return content
      .filter((block: unknown) => isRecord(block))
      .map((block: Record<string, unknown>) => {
        if (block.type === "text" && typeof block.text === "string") return block.text;
        if (block.type === "tool_use") {
          return `[Tool use: ${String(block.name ?? "unknown")}]`;
        }
        if (block.type === "tool_result") return `[Tool result]`;
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  return "";
}

/** Convert Claude role labels to standard roles. */
function normalizeClaudeRole(sender: string): string {
  if (sender === "human" || sender === "user") return "user";
  if (sender === "assistant" || sender === "claude" || sender === "bot") return "assistant";
  return sender;
}

/** Normalize role to one of the known roles. */
function normalizeRole(role: string): string {
  const lower = role.toLowerCase().trim();
  if (lower === "human" || lower === "user" || lower === "you") return "user";
  if (lower === "assistant" || lower === "ai" || lower === "bot" || lower === "claude" || lower === "gpt") return "assistant";
  if (lower === "system") return "system";
  // Preserve unknown roles (they may carry semantic meaning).
  return lower;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

/**
 * Serialize session + messages to the canonical JSON format.
 */
function serializeJSON(
  sessionRow: Record<string, unknown>,
  msgRows: Record<string, unknown>[],
  _opts?: ExportOptions,
): Buffer {
  const exportData: ExportedSessionV1 = {
    formatVersion: 1,
    tool: "c0de-agent",
    exportedAt: isoNow(),
    session: {
      id: String(sessionRow.id),
      title: _opts?.title ?? String(sessionRow.title ?? ""),
      parentId: sessionRow.parentId ? String(sessionRow.parentId) : null,
      branchPoint: sessionRow.branchPoint != null ? Number(sessionRow.branchPoint) : null,
      metadata: (sessionRow.metadata as SessionMetadata) ?? {},
      createdAt: sessionRow.createdAt instanceof Date
        ? sessionRow.createdAt.toISOString()
        : String(sessionRow.createdAt ?? isoNow()),
      updatedAt: sessionRow.updatedAt instanceof Date
        ? sessionRow.updatedAt.toISOString()
        : String(sessionRow.updatedAt ?? isoNow()),
    },
    messages: msgRows.map((r) => ({
      role: String(r.role ?? "user"),
      content: r.content,
      tokenCount: Number(r.tokenCount ?? 0),
      createdAt: r.createdAt instanceof Date
        ? r.createdAt.toISOString()
        : String(r.createdAt ?? isoNow()),
    })),
  };

  return Buffer.from(JSON.stringify(exportData, null, 2), "utf-8");
}

/**
 * Serialize session + messages to a human-readable Markdown transcript.
 */
function serializeMarkdown(
  sessionRow: Record<string, unknown>,
  msgRows: Record<string, unknown>[],
  _opts?: ExportOptions,
): Buffer {
  const lines: string[] = [];
  const title = _opts?.title ?? String(sessionRow.title ?? "Untitled Session");
  const createdAt = sessionRow.createdAt instanceof Date
    ? sessionRow.createdAt.toISOString()
    : String(sessionRow.createdAt ?? "?");
  const updatedAt = sessionRow.updatedAt instanceof Date
    ? sessionRow.updatedAt.toISOString()
    : String(sessionRow.updatedAt ?? "?");

  lines.push(`# Session: ${title}`);
  lines.push("");
  lines.push(`- **ID**: \`${sessionRow.id}\``);
  lines.push(`- **Created**: ${createdAt}`);
  lines.push(`- **Updated**: ${updatedAt}`);
  lines.push(`- **Messages**: ${msgRows.length}`);
  if (sessionRow.parentId) {
    lines.push(`- **Parent**: \`${String(sessionRow.parentId)}\``);
  }
  if (sessionRow.branchPoint != null) {
    lines.push(`- **Branch point**: ${String(sessionRow.branchPoint)}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Messages");
  lines.push("");

  for (const row of msgRows) {
    const role = String(row.role ?? "unknown");
    const ts = row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : String(row.createdAt ?? "");

    lines.push(`### ${capitalizeRole(role)} (${ts})`);
    lines.push("");

    const content = renderContent(row.content);
    lines.push(content);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return Buffer.from(lines.join("\n"), "utf-8");
}

/** Render message content as text for markdown export. */
function renderContent(content: unknown): string {
  if (content === null || content === undefined) return "*empty*";
  if (typeof content === "string") {
    // If it's a string that looks like JSON, try to pretty-print it.
    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return content || "*empty*";
    }
  }

  // Object content — typically tool calls or structured data.
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/** Capitalize role for display (e.g. "user" → "User"). */
function capitalizeRole(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

// ---------------------------------------------------------------------------
// HTML serializer
// ---------------------------------------------------------------------------

/**
 * Render message content as safe HTML text (escapes < > & " for inline use).
 * Code blocks and structured JSON get <pre><code> treatment.
 */
function renderContentHTML(content: unknown): string {
  if (content === null || content === undefined) return "<em>empty</em>";

  let text: string;
  if (typeof content === "string") {
    // If it's JSON, pretty-print it.
    try {
      text = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      text = content;
    }
  } else {
    try {
      text = JSON.stringify(content, null, 2);
    } catch {
      text = String(content);
    }
  }

  if (text.length === 0) return "<em>empty</em>";

  // Escape HTML entities.
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  // If the content looks like a code block (multi-line, starts/ends with { or [),
  // wrap in pre/code.
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return `<pre><code>${escaped}</code></pre>`;
  }

  // Regular multi-line text → preserve line breaks.
  return escaped.replace(/\n/g, "<br>");
}

/**
 * CSS for the HTML export. Self-contained — no external assets required.
 */
function exportStylesheet(): string {
  return `
:root {
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #6b7280;
  --border: #e5e7eb;
  --accent: #2563eb;
  --user-bg: #eff6ff;
  --assistant-bg: #f9fafb;
  --code-bg: #f3f4f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111827;
    --fg: #f3f4f6;
    --muted: #9ca3af;
    --border: #374151;
    --accent: #60a5fa;
    --user-bg: #1e293b;
    --assistant-bg: #1f2937;
    --code-bg: #1e293b;
  }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
  background: var(--bg); color: var(--fg);
  line-height: 1.6; padding: 2rem; max-width: 800px; margin: 0 auto;
}
h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
.meta { color: var(--muted); font-size: 0.875rem; margin-bottom: 1.5rem; }
.meta dt { display: inline; font-weight: 600; }
.meta dd { display: inline; margin: 0 1rem 0 0.25rem; }
.message {
  padding: 1rem 1.25rem; margin-bottom: 1rem; border-radius: 0.75rem;
  border: 1px solid var(--border);
}
.message.user { background: var(--user-bg); }
.message.assistant { background: var(--assistant-bg); }
.message.system { background: var(--code-bg); }
.msg-header { font-size: 0.75rem; color: var(--muted); margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; }
.msg-body { font-size: 0.9375rem; }
pre { background: var(--code-bg); padding: 1rem; border-radius: 0.5rem; overflow-x: auto; margin: 0.5rem 0; }
code { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; font-size: 0.875em; }
footer { margin-top: 2rem; text-align: center; color: var(--muted); font-size: 0.75rem; }
`;
}

/**
 * Serialize session + messages to a self-contained HTML document.
 *
 * The output is a valid HTML5 page with embedded CSS (no external assets).
 * Suitable for direct browser viewing, email attachment, or printing.
 */
function serializeHTML(
  sessionRow: Record<string, unknown>,
  msgRows: Record<string, unknown>[],
  _opts?: ExportOptions,
): Buffer {
  const title = _opts?.title ?? String(sessionRow.title ?? "Untitled Session");
  const createdAt = sessionRow.createdAt instanceof Date
    ? sessionRow.createdAt.toISOString()
    : String(sessionRow.createdAt ?? "?");
  const updatedAt = sessionRow.updatedAt instanceof Date
    ? sessionRow.updatedAt.toISOString()
    : String(sessionRow.updatedAt ?? "?");
  const sessionId = String(sessionRow.id ?? "");

  const messagesHTML = msgRows.map((row) => {
    const role = String(row.role ?? "unknown");
    const ts = row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : String(row.createdAt ?? "");
    const roleClass = ["user", "assistant", "system"].includes(role) ? role : "system";
    const body = renderContentHTML(row.content);

    return `      <div class="message ${roleClass}">
        <div class="msg-header">${escapeHTML(capitalizeRole(role))} &mdash; ${escapeHTML(ts)}</div>
        <div class="msg-body">${body}</div>
      </div>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(title)}</title>
  <style>${exportStylesheet()}</style>
</head>
<body>
  <h1>${escapeHTML(title)}</h1>
  <dl class="meta">
    <dt>ID</dt><dd><code>${escapeHTML(sessionId)}</code></dd>
    <dt>Created</dt><dd>${escapeHTML(createdAt)}</dd>
    <dt>Updated</dt><dd>${escapeHTML(updatedAt)}</dd>
    <dt>Messages</dt><dd>${msgRows.length}</dd>
  </dl>

  <div class="messages">
${messagesHTML}
  </div>

  <footer>Exported from c0de-agent &mdash; ${escapeHTML(new Date().toISOString())}</footer>
</body>
</html>`;

  return Buffer.from(html, "utf-8");
}

/** Escape HTML entities for safe inline use. */
function escapeHTML(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
