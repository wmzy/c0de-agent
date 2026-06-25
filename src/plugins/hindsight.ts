// Hindsight plugin — Oh-My-OpenAgent style hindsight (§7.6).
//
// Captures lessons from failed operations and injects them as context
// so the agent avoids repeating the same mistakes.
//
// Hook points:
//   - "tool:after" — detect failed tool executions and record a lesson.
//   - "message:before" — inject relevant historical lessons before each
//     LLM call so the model is aware of past failures.
//
// Storage: in-memory Map keyed by sessionId. Each session maintains its own
// list of HindsightEntry records. Entries are lightweight plain objects
// (action / outcome / lesson / timestamp) so they survive across iterations
// within a single agent run.
//
// Conventions: data + functions, no class, no enum.

import type { Plugin } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single hindsight record capturing a lesson from a failed operation. */
export type HindsightEntry = {
  /** The action that was attempted (tool name + args summary). */
  action: string;
  /** The observed outcome (error message or failure signal). */
  outcome: string;
  /** A distilled lesson the agent should remember. */
  lesson: string;
  /** Unix timestamp (ms) when the entry was recorded. */
  timestamp: number;
};

/** Query filters for retrieving relevant hindsight entries. */
export type HindsightQuery = {
  /** Session to query (defaults to all sessions). */
  sessionId?: string;
  /** Only entries mentioning this tool name. */
  tool?: string;
  /** Maximum number of entries to return. */
  limit?: number;
  /** Only entries within this many ms of `now`. */
  recencyMs?: number;
};

/** In-memory store keyed by sessionId. */
const HINDSIGHT_STORE = new Map<string, HindsightEntry[]>();

function getOrCreateList(sessionId: string): HindsightEntry[] {
  let list = HINDSIGHT_STORE.get(sessionId);
  if (!list) {
    list = [];
    HINDSIGHT_STORE.set(sessionId, list);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a hindsight entry for the given session.
 *
 * The entry is appended to the session's list. Deduplication is performed
 * against recent entries: if an entry with the same (action, outcome) pair
 * already exists within the last `MAX_RECENT_DEDUP` entries, it is skipped.
 */
export async function recordHindsight(
  sessionId: string,
  entry: Omit<HindsightEntry, "timestamp">,
): Promise<void> {
  const list = getOrCreateList(sessionId);

  // Deduplicate against the tail of the list
  const dedupWindow = list.slice(-MAX_RECENT_DEDUP);
  const alreadyRecorded = dedupWindow.some(
    (e) => e.action === entry.action && e.outcome === entry.outcome,
  );
  if (alreadyRecorded) return;

  list.push({ ...entry, timestamp: Date.now() });

  // Trim to keep memory bounded
  if (list.length > MAX_ENTRIES_PER_SESSION) {
    list.splice(0, list.length - MAX_ENTRIES_PER_SESSION);
  }
}

/**
 * Query hindsight entries relevant to the current context.
 *
 * When `query.tool` is provided, only entries mentioning that tool are
 * returned. Results are sorted by timestamp descending (most recent first)
 * and capped at `query.limit` (default `MAX_DEFAULT_LIMIT`).
 */
export async function getHindsight(query?: HindsightQuery): Promise<HindsightEntry[]> {
  const sessionId = query?.sessionId;
  const tool = query?.tool;
  const limit = query?.limit ?? MAX_DEFAULT_LIMIT;
  const recencyMs = query?.recencyMs;
  const now = Date.now();

  const candidates: HindsightEntry[] = [];

  if (sessionId) {
    const list = HINDSIGHT_STORE.get(sessionId);
    if (list) {
      candidates.push(...list);
    }
  } else {
    for (const entries of HINDSIGHT_STORE.values()) {
      candidates.push(...entries);
    }
  }

  // Filter by tool
  if (tool) {
    const toolLower = tool.toLowerCase();
    for (const e of candidates) {
      if (!e.action.toLowerCase().includes(toolLower)) {
        continue;
      }
      // (tool filter applied to action string which contains the tool name)
    }
    // Rebuild filtered list
    const filtered: HindsightEntry[] = [];
    for (const e of candidates) {
      if (e.action.toLowerCase().includes(toolLower)) {
        filtered.push(e);
      }
    }
    candidates.length = 0;
    candidates.push(...filtered);
  }

  // Filter by recency
  if (recencyMs) {
    const cutoff = now - recencyMs;
    candidates.length = 0;
    for (const e of candidates) {
      if (e.timestamp >= cutoff) candidates.push(e);
    }
  }

  // Sort by timestamp descending (most recent first)
  candidates.sort((a, b) => b.timestamp - a.timestamp);

  return candidates.slice(0, limit);
}

/**
 * Clear all hindsight entries for a session (e.g. on session end).
 */
export function clearHindsight(sessionId: string): void {
  HINDSIGHT_STORE.delete(sessionId);
}

/**
 * Get the raw list for a session (used by the plugin's message:before hook).
 */
export function getSessionEntries(sessionId: string): HindsightEntry[] {
  return HINDSIGHT_STORE.get(sessionId) ?? [];
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Create the hindsight plugin.
 *
 * Registers two hooks:
 *   1. "tool:after" — when a tool returns an error, record a hindsight entry
 *      with a distilled lesson.
 *   2. "message:before" — inject relevant historical lessons as a system
 *      message so the agent is aware of past failures.
 */
export function createHindsightPlugin(): Plugin {
  return {
    name: "hindsight",
    version: "1.0.0",
    setup: (ctx) => {
      const logger = ctx.getLogger("hindsight");

      // --- Hook: tool:after — record lessons from failed operations ---
      ctx.registerHook("tool:after", (data) => {
        const result = data.result as { _tag?: string; error?: string };
        if (result?._tag !== "error" || !result.error) {
          return data;
        }

        const toolName = data.tool;
        const input = data.input as string;
        const errorMessage = result.error;

        // Derive a concise action summary
        const actionSummary = summarizeAction(toolName, input);

        // Derive a lesson from the error
        const lesson = deriveLesson(toolName, errorMessage);

        // We need the sessionId — it's not in the hook data directly.
        // The plugin context doesn't expose it, so we use a module-level
        // registry keyed by a "current session" that the agent loop sets.
        // In practice, the agent loop calls setHindsightSession() before
        // each runAgent invocation.
        const sessionId = getCurrentSessionId();
        if (!sessionId) {
          // No session context — skip recording
          return data;
        }

        // Record asynchronously (fire-and-forget) so we don't block the loop
        recordHindsight(sessionId, {
          action: actionSummary,
          outcome: errorMessage,
          lesson,
        }).catch((err) => {
          logger.error("Failed to record hindsight: %s", err);
        });

        return data;
      });

      // --- Hook: message:before — inject relevant lessons ---
      ctx.registerHook("message:before", (data) => {
        const messages = (data as { messages?: unknown[] })?.messages;
        if (!messages || !Array.isArray(messages)) return data;

        const sessionId = getCurrentSessionId();
        if (!sessionId) return data;

        const entries = getSessionEntries(sessionId);
        if (entries.length === 0) return data;

        // Determine which tools are likely to be used next by scanning
        // the most recent user/assistant messages for tool names.
        const likelyTools = inferLikelyTools(messages);

        // Select relevant entries: prefer entries matching likely tools,
        // then fall back to most recent entries.
        const relevant = selectRelevantEntries(entries, likelyTools, MAX_INJECT_LIMIT);
        if (relevant.length === 0) return data;

        const injection = formatHindsightInjection(relevant);

        // Prepend as a system message
        const newMessages = [
          { role: "system" as const, content: injection },
          ...messages,
        ];
        return { ...data, messages: newMessages };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Session context — set by the agent loop before each runAgent call
// ---------------------------------------------------------------------------

let currentSessionId: string | null = null;

/**
 * Set the current session id for hindsight recording.
 * Called by the agent loop at the start of runAgent().
 */
export function setHindsightSession(sessionId: string | null): void {
  currentSessionId = sessionId;
}

function getCurrentSessionId(): string | null {
  return currentSessionId;
}

// ---------------------------------------------------------------------------
// Internals — lesson derivation and injection formatting
// ---------------------------------------------------------------------------

const MAX_ENTRIES_PER_SESSION = 50;
const MAX_RECENT_DEDUP = 20;
const MAX_DEFAULT_LIMIT = 10;
const MAX_INJECT_LIMIT = 5;

/**
 * Summarize a tool call into a concise action string.
 */
function summarizeAction(toolName: string, input: string): string {
  // Truncate long inputs to keep entries readable
  const truncated = input.length > 200 ? input.slice(0, 200) + "…" : input;
  return `${toolName}(${truncated})`;
}

/**
 * Derive a distilled lesson from a tool error.
 *
 * Uses keyword-based heuristics to produce actionable advice rather than
 * just echoing the error message.
 */
function deriveLesson(toolName: string, error: string): string {
  const lower = error.toLowerCase();

  // File-not-found patterns
  if (/no such file|file not found|cannot find|does not exist|ENOENT/i.test(lower)) {
    return `File not found when using ${toolName}. Verify the file exists and the path is correct before retrying.`;
  }

  // Permission denied
  if (/permission denied|EACCES|access denied/i.test(lower)) {
    return `Permission denied when using ${toolName}. Check file permissions or try running with elevated privileges.`;
  }

  // JSON parse error
  if (/invalid json|json parse|unexpected token|parse error/i.test(lower)) {
    return `JSON parse error in ${toolName}. Ensure the input is valid JSON with proper quoting and commas.`;
  }

  // Syntax error
  if (/syntax error|unexpected|parse failed/i.test(lower)) {
    return `Syntax error in ${toolName}. Check the input format and ensure it matches the expected schema.`;
  }

  // Timeout
  if (/timeout|timed out|deadline exceeded/i.test(lower)) {
    return `Timeout when using ${toolName}. The operation may be too slow; consider breaking it into smaller steps.`;
  }

  // Network error
  if (/network|connection refused|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(lower)) {
    return `Network error when using ${toolName}. Check connectivity and that the target service is running.`;
  }

  // Git conflicts
  if (/conflict|merge|unmerged|both modified/i.test(lower)) {
    return `Git conflict when using ${toolName}. Resolve conflicts manually before proceeding.`;
  }

  // Edit failed (stale content, wrong old_text)
  if (/edit.*failed|no match|old_text not found|replacement failed/i.test(lower)) {
    return `Edit failed in ${toolName}. Re-read the file to get the current content before retrying the edit.`;
  }

  // Tool not found
  if (/unknown tool|tool.*not found|not registered/i.test(lower)) {
    return `Tool "${toolName}" not found. Check the tool name spelling and that the tool is available.`;
  }

  // Generic fallback
  return `Failed ${toolName}: ${error.slice(0, 150)}. Review the error and adjust the approach before retrying.`;
}

/**
 * Infer which tools are likely to be used next by scanning recent messages.
 */
function inferLikelyTools(messages: unknown[]): string[] {
  const tools = new Set<string>();
  const KNOWN_TOOLS = [
    "read",
    "write",
    "edit",
    "bash",
    "search",
    "find",
    "ast_grep",
    "ast_edit",
    "eval",
    "browser",
    "task",
    "generate_image",
  ];

  // Look at the last few messages for tool references
  const recent = messages
    .filter((m): m is { role: string; content: string } =>
      typeof m === "object" &&
      m !== null &&
      "role" in m &&
      "content" in m &&
      typeof (m as { content: unknown }).content === "string",
    )
    .slice(-5);

  for (const msg of recent) {
    const text = msg.content.toLowerCase();
    for (const tool of KNOWN_TOOLS) {
      if (text.includes(tool)) {
        tools.add(tool);
      }
    }
  }

  return Array.from(tools);
}

/**
 * Select relevant hindsight entries for injection.
 *
 * Prioritizes entries matching likely tools, then falls back to most recent.
 */
function selectRelevantEntries(
  entries: HindsightEntry[],
  likelyTools: string[],
  limit: number,
): HindsightEntry[] {
  if (likelyTools.length === 0) {
    return entries.slice(0, limit);
  }

  const matched: HindsightEntry[] = [];
  const unmatched: HindsightEntry[] = [];

  const toolSet = new Set(likelyTools.map((t) => t.toLowerCase()));

  for (const entry of entries) {
    const actionLower = entry.action.toLowerCase();
    const matches = Array.from(toolSet).some((t) => actionLower.includes(t));
    if (matches) {
      matched.push(entry);
    } else {
      unmatched.push(entry);
    }
  }

  // Sort both by timestamp descending
  matched.sort((a, b) => b.timestamp - a.timestamp);
  unmatched.sort((a, b) => b.timestamp - a.timestamp);

  // Fill slots: prefer matched, then unmatched
  const selected: HindsightEntry[] = [];
  for (const e of matched) {
    if (selected.length >= limit) break;
    selected.push(e);
  }
  for (const e of unmatched) {
    if (selected.length >= limit) break;
    selected.push(e);
  }

  return selected;
}

/**
 * Format hindsight entries into a system message injection.
 */
function formatHindsightInjection(entries: HindsightEntry[]): string {
  const lines = [
    "## Hindsight — Lessons from Past Failures",
    "",
    "The following lessons were learned from failed operations in this session. Consider them before attempting similar actions:",
    "",
  ];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const age = formatAge(e.timestamp);
    lines.push(`${i + 1}. **${e.lesson}** (${age})`);
  }

  lines.push("");
  lines.push("_Do not repeat the same mistakes. If you encounter a similar situation, apply these lessons._");

  return lines.join("\n");
}

/**
 * Format a timestamp as a relative age string.
 */
function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}
