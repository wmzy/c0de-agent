// Compaction todo preserver plugin.
//
// When context compaction occurs, older messages are replaced with a summary.
// This plugin extracts TODO/FIXME/HACK markers from the messages being
// compacted and preserves them so they are not lost.
//
// Supports multiple comment formats:
//   - // TODO ... / // FIXME ... / // HACK ...  (C-style single-line)
//   - # TODO ... / # FIXME ... / # HACK ...     (shell/python style)
//   - /* TODO ... */ /* FIXME ... */ /* HACK ... */ (C-style block)
//   - -- TODO ... (SQL/lua style)
//
// Hook point: "message:before" — detects compaction summaries, extracts
// todos from surrounding messages, and injects a preservation block.
//
// Conventions: data + functions, no class, no enum.

// ---------------------------------------------------------------------------
// TodoItem — a single extracted TODO/FIXME/HACK entry.
// ---------------------------------------------------------------------------

export type TodoItem = {
  /** The tag: "TODO" | "FIXME" | "HACK". */
  tag: "TODO" | "FIXME" | "HACK";
  /** The description text following the tag. */
  text: string;
  /** File path or source context where the item was found, if known. */
  source?: string;
};

// ---------------------------------------------------------------------------
// TodoCapture — structured collection of extracted todo items.
// ---------------------------------------------------------------------------

export type TodoCapture = {
  items: TodoItem[];
};

// ---------------------------------------------------------------------------
// MessageLike — minimal message shape for extraction.
// ---------------------------------------------------------------------------

export type MessageLike = {
  role: "user" | "assistant" | "system" | "tool";
  content: string | unknown[];
  name?: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// extractTodos — scan messages and extract TODO/FIXME/HACK markers.
//
// Scans all messages for inline todo items. Recognizes multiple comment
// formats and deduplicates identical entries.
//
// Returns a TodoCapture with unique entries.
// ---------------------------------------------------------------------------

export function extractTodos(messages: MessageLike[]): TodoCapture {
  const seen = new Set<string>();
  const items: TodoItem[] = [];

  for (const msg of messages) {
    const text = extractText(msg);
    if (!text) continue;

    const found = extractTodosFromText(text);
    for (const item of found) {
      const key = `${item.tag}:${item.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        items.push(item);
      }
    }
  }

  return { items };
}

// ---------------------------------------------------------------------------
// buildTodoInjection — format a TodoCapture into an injectable string.
//
// Produces a structured block that can be appended to a compaction summary
// so the model retains awareness of outstanding work items.
// ---------------------------------------------------------------------------

export function buildTodoInjection(todos: TodoCapture): string {
  if (todos.items.length === 0) return "";

  const lines: string[] = [
    "",
    "## Outstanding TODOs / FIXMEs / HACKs",
    "",
  ];

  // Group by tag for readability.
  const grouped = groupByTag(todos.items);
  for (const tag of ["TODO", "FIXME", "HACK"] as const) {
    const tagItems = grouped[tag];
    if (!tagItems || tagItems.length === 0) continue;
    for (const item of tagItems) {
      const src = item.source ? ` (${item.source})` : "";
      lines.push(`- [${item.tag}] ${item.text}${src}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// preserveTodosInCompaction — the core hook handler.
//
// Detects whether a compaction summary is present in the message list.
// If so, extracts TODOs from the messages and appends them to the summary
// content so they survive compaction.
//
// Returns a new messages array leaving the original untouched.
// ---------------------------------------------------------------------------

export function preserveTodosInCompaction(messages: unknown[]): unknown[] {
  const msgArray = Array.isArray(messages) ? messages : [];
  const typed: MessageLike[] = msgArray.filter(isMessageLike) as MessageLike[];

  // Find the compaction summary message.
  const summaryIdx = typed.findIndex((m) => isCompactionSummary(m));
  if (summaryIdx < 0) return messages;

  // Extract todos from all messages (including the summary's original content).
  const todos = extractTodos(typed);
  if (todos.items.length === 0) return messages;

  // Append the todo block to the existing summary.
  const summary = typed[summaryIdx]!;
  const existingText = extractText(summary) ?? "";
  const todoBlock = buildTodoInjection(todos);

  // Avoid double-injecting if todos are already preserved.
  if (existingText.includes("Outstanding TODOs")) return messages;

  const updated: MessageLike = {
    ...summary,
    content: existingText + "\n" + todoBlock,
  };

  // Clone the array with the updated summary.
  const result: unknown[] = [...msgArray];
  result[summaryIdx] = updated;
  return result;
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

import type { Plugin } from "./types";

/**
 * Create the compaction todo preserver plugin.
 *
 * Registers a "message:before" hook that detects compaction summaries
 * and appends extracted TODO/FIXME/HACK items to the summary so they
 * are preserved across compactions.
 */
export function createCompactionTodoPreserverPlugin(): Plugin {
  return {
    name: "compaction-todo-preserver",
    version: "1.0.0",
    setup: (ctx) => {
      ctx.registerHook("message:before", (data) => {
        const messages = (data as { messages?: unknown[] })?.messages;
        if (!messages) return data;
        return { ...data, messages: preserveTodosInCompaction(messages) };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Internals — extraction helpers
// ---------------------------------------------------------------------------

const MAX_TODO_LENGTH = 300;

// Patterns for extracting TODO/FIXME/HACK from various comment formats.
// Each pattern captures the tag and the description text.
const TODO_PATTERNS: RegExp[] = [
  // C-style single-line: // TODO: fix this
  /\/\/\s*(TODO|FIXME|HACK)\b[:\s]+(.+?)(?:\s*\*\/)?$/gim,
  // Shell/python style: # TODO: fix this
  /#\s*(TODO|FIXME|HACK)\b[:\s]+(.+?)$/gim,
  // C-style block: /* TODO: fix this */
  /\/\*\s*(TODO|FIXME|HACK)\b[:\s]+(.+?)\s*\*\//gi,
  // SQL/lua style: -- TODO: fix this
  /--\s*(TODO|FIXME|HACK)\b[:\s]+(.+?)$/gim,
  // HTML style: <!-- TODO: fix this -->
  /<!--\s*(TODO|FIXME|HACK)\b[:\s]+(.+?)-->/gi,
  // Bare markers in prose: TODO: fix this, FIXME: broken
  /\b(TODO|FIXME|HACK)\b[:\s]+([^\n]{5,})/gi,
];

function extractTodosFromText(text: string): TodoItem[] {
  const items: TodoItem[] = [];

  for (const regex of TODO_PATTERNS) {
    // Reset lastIndex for global regexes.
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const rawTag = (match[1] ?? "").toUpperCase();
      const rawText = (match[2] ?? "").trim();

      if (!rawTag || !rawText) continue;
      if (rawText.length < 3 || rawText.length > MAX_TODO_LENGTH) continue;

      // Validate tag is one of the three.
      const tag = rawTag as "TODO" | "FIXME" | "HACK";
      if (tag !== "TODO" && tag !== "FIXME" && tag !== "HACK") continue;

      items.push({ tag, text: cleanupText(rawText) });
    }
  }

  return items;
}

function cleanupText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[-–—*•]\s*/, "")
    .replace(/\s*\*\/\s*$/, "")   // strip trailing block-comment closer
    .replace(/\s*-->\s*$/, "")     // strip trailing HTML comment closer
    .replace(/\s*-+\s*$/, "")      // strip trailing dashes
    .trim();
}

function groupByTag(
  items: TodoItem[],
): Partial<Record<"TODO" | "FIXME" | "HACK", TodoItem[]>> {
  const groups: Partial<Record<"TODO" | "FIXME" | "HACK", TodoItem[]>> = {};
  for (const item of items) {
    const arr = groups[item.tag] ?? [];
    arr.push(item);
    groups[item.tag] = arr;
  }
  return groups;
}

function extractText(msg: MessageLike): string | null {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null && "text" in part) {
          return String((part as { text: unknown }).text);
        }
        return "";
      })
      .join(" ");
  }
  return null;
}

function isMessageLike(m: unknown): m is MessageLike {
  return (
    typeof m === "object" &&
    m !== null &&
    "role" in m &&
    "content" in m &&
    typeof (m as { role: unknown }).role === "string"
  );
}

function isCompactionSummary(m: MessageLike): boolean {
  if (m.role !== "system") return false;
  const text = extractText(m);
  if (!text) return false;
  return (
    text.includes("[Compacted summary") ||
    text.includes("[Compaction Context") ||
    (m.name === "compaction-context" && true) ||
    (typeof m.id === "string" && (m.id as string).startsWith("summary-"))
  );
}
