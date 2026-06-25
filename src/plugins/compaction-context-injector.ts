// Compaction context injector plugin.
//
// When context compaction occurs, older messages are replaced with a summary.
// This plugin preserves the operational context that would otherwise be lost:
//   - Key decisions and progress made during the session
//   - List of files modified by tool calls
//   - Next steps / plan the agent intends to follow
//
// Hook point: "message:before" (transforms the messages array before it's
// sent to the LLM).  Detects a compaction summary message and prepends a
// structured context injection so the model retains awareness of what was
// compacted away.
//
// Conventions: data + functions, no class, no enum.

// ---------------------------------------------------------------------------
// MessageLike — minimal message shape required for injection.
//
// The plugin operates at the "message:before" hook boundary where messages
// arrive as unknown[]. We accept any structurally compatible message to
// avoid a hard dependency on core types at the plugin level.
// ---------------------------------------------------------------------------

export type MessageLike = {
  role: "user" | "assistant" | "system" | "tool";
  content: string | unknown[];
  name?: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// ContextCapture — structured context extracted from the conversation.
// ---------------------------------------------------------------------------

export type ContextCapture = {
  /** File paths referenced in tool calls (write, edit, bash, etc.). */
  modifiedFiles: string[];
  /** Key decisions extracted from assistant reasoning. */
  decisions: string[];
  /** Next steps / plan stated by the agent. */
  nextSteps: string[];
};

// ---------------------------------------------------------------------------
// extractContext — scan messages and extract operational context.
//
// Scans the full message list (including the compacted summary if present)
// to recover context that would otherwise be lost in compaction.
//
// Strategy:
//   - modifiedFiles: collect file paths from tool call arguments across all
//     assistant and tool messages.  Recognized tools: write, edit, bash,
//     read, ast_grep, ast_edit, find, search, generate_image.
//   - decisions: extract sentences containing decision keywords from
//     assistant messages (decided, chose, selecting, will use, decided to,
//     going with, opted for).
//   - nextSteps: extract sentences containing plan keywords from the most
//     recent assistant message (next step, next, plan, TODO, TODO:, will do,
//     will implement, to do, remaining).
//
// Returns a ContextCapture with deduplicated entries.
// ---------------------------------------------------------------------------

export function extractContext(messages: MessageLike[]): ContextCapture {
  const modifiedFiles = new Set<string>();
  const decisions = new Set<string>();
  const nextSteps = new Set<string>();

  for (const msg of messages) {
    const text = extractText(msg);
    if (!text) continue;

    // --- Modified files from tool calls ---
    if (msg.role === "assistant" || msg.role === "tool") {
      const filePaths = extractFilePaths(text);
      for (const fp of filePaths) {
        modifiedFiles.add(fp);
      }
    }

    // --- Decisions from assistant messages ---
    if (msg.role === "assistant") {
      const found = extractDecisions(text);
      for (const d of found) {
        decisions.add(d);
      }
    }
  }

  // --- Next steps from the most recent assistant message ---
  const lastAssistant = findLastAssistant(messages);
  if (lastAssistant) {
    const text = extractText(lastAssistant);
    if (text) {
      const found = extractNextSteps(text);
      for (const ns of found) {
        nextSteps.add(ns);
      }
    }
  }

  return {
    modifiedFiles: [...modifiedFiles].sort(),
    decisions: [...decisions].slice(0, MAX_DECISIONS),
    nextSteps: [...nextSteps].slice(0, MAX_NEXT_STEPS),
  };
}

// ---------------------------------------------------------------------------
// buildContextInjection — format a ContextCapture into an injectable string.
//
// Produces a structured block that can be prepended to the message list as
// a system message.  Sections are omitted when empty to keep the injection
// minimal.
// ---------------------------------------------------------------------------

export function buildContextInjection(ctx: ContextCapture): string {
  const lines: string[] = ["[Compaction Context — preserved from compacted messages]"];

  if (ctx.modifiedFiles.length > 0) {
    lines.push("");
    lines.push("## Modified Files");
    for (const f of ctx.modifiedFiles) {
      lines.push(`- \`${f}\``);
    }
  }

  if (ctx.decisions.length > 0) {
    lines.push("");
    lines.push("## Key Decisions & Progress");
    for (const d of ctx.decisions) {
      lines.push(`- ${d}`);
    }
  }

  if (ctx.nextSteps.length > 0) {
    lines.push("");
    lines.push("## Next Steps");
    for (const ns of ctx.nextSteps) {
      lines.push(`- ${ns}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// injectCompactionContext — the core hook handler.
//
// Detects whether a compaction summary is present in the message list.
// If so, extracts context from the remaining messages and prepends a
// structured context injection as a system message.
//
// Returns a new messages array leaving the original untouched.
// ---------------------------------------------------------------------------

export function injectCompactionContext(messages: unknown[]): unknown[] {
  const msgArray = Array.isArray(messages) ? messages : [];
  const typed: MessageLike[] = msgArray.filter(isMessageLike) as MessageLike[];

  // Check if a compaction summary is present
  const hasSummary = typed.some((m) => isCompactionSummary(m));
  if (!hasSummary) return messages;

  // Extract context from the messages (excluding the summary itself)
  const ctx = extractContext(typed);

  // Skip injection if there's nothing meaningful to preserve
  if (
    ctx.modifiedFiles.length === 0 &&
    ctx.decisions.length === 0 &&
    ctx.nextSteps.length === 0
  ) {
    return messages;
  }

  // Build and prepend the context injection
  const injectionText = buildContextInjection(ctx);
  const injection: MessageLike = {
    role: "system",
    content: injectionText,
    name: "compaction-context",
  };

  return [...msgArray, injection].filter((m): m is unknown => true);
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

import type { Plugin } from "./types";

/**
 * Create the compaction context injector plugin.
 *
 * Registers a "message:before" hook that detects compaction summaries and
 * injects preserved context (decisions, modified files, next steps) as
 * a system message so the model retains awareness across compactions.
 */
export function createCompactionContextPlugin(): Plugin {
  return {
    name: "compaction-context-injector",
    version: "1.0.0",
    setup: (ctx) => {
      ctx.registerHook("message:before", (data) => {
        const messages = (data as { messages?: unknown[] })?.messages;
        if (!messages) return data;
        return { ...data, messages: injectCompactionContext(messages) };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Internals — helpers for context extraction
// ---------------------------------------------------------------------------

const MAX_DECISIONS = 10;
const MAX_NEXT_STEPS = 10;

// Decision keywords — phrases that indicate a deliberate choice was made.
const DECISION_PATTERNS = [
  /(?:decided|chose|selecting|will use|decided to|going with|opted for|settled on)\b[^.]{0,120}\./gi,
  /\b(?:I'll|we'll|let's)\s+(?:use|go with|try|implement|apply)\b[^.]{0,120}\./gi,
];

// Next-step keywords — phrases that indicate future intent or a plan.
const NEXT_STEP_PATTERNS = [
  /\b(?:next step|next,?|plan|TODO[:\s]|will do|will implement|to do|remaining|follow-up)\b[^.]{0,120}\./gi,
  /\b(?:after this|then|finally|once|subsequently)\b[^.]{0,120}\./gi,
];

// File path patterns — matches paths in tool call arguments and prose.
const FILE_PATH_PATTERNS = [
  // Explicit paths: src/foo.ts, ./dir/file.md, /abs/path/file
  /(?:^|[\s"'\(])(?:\.{1,2}\/|\/)?[\w\-.]+(?:\/[\w\-.]+)*\.(?:ts|tsx|js|jsx|py|md|txt|json|yaml|yml|toml|css|html|sh|sql|db|sqlite|svg|png|jpg|jpeg|gif|webp|pdf|zip|tar|gz|log|cfg|conf|ini|env|lock|map|d\.ts)(?:[\s"'\)]|$)/gi,
  // Paths in tool call signatures: "path": "src/foo.ts"
  /"path"\s*:\s*"([^"]+)"/gi,
  // Paths after tool names: write src/foo.ts, edit src/foo.ts
  /\b(?:write|edit|read|create|update|modify|delete)\s+([^\s,;]+(?:\/[^\s,;]+)+)/gi,
];

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

function extractFilePaths(text: string): string[] {
  const paths: string[] = [];

  // Match explicit paths
  const explicitMatches = text.matchAll(
    /(?:^|[\s"'\(])(?:\.{1,2}\/|\/)?[\w\-.]+(?:\/[\w\-.]+)*\.(?:ts|tsx|js|jsx|py|md|txt|json|yaml|yml|toml|css|html|sh|sql|db|sqlite|svg|png|jpg|jpeg|gif|webp|pdf|zip|tar|gz|log|cfg|conf|ini|env|lock|map|d\.ts)(?:[\s"'\)]|$)/gi,
  );
  for (const m of explicitMatches) {
    const path = m[0].trim();
    if (path.length > 2 && isValidPath(path)) {
      paths.push(path);
    }
  }

  // Match "path": "value" patterns
  const pathMatches = text.matchAll(/"path"\s*:\s*"([^"]+)"/gi);
  for (const m of pathMatches) {
    if (isValidPath(m[1])) {
      paths.push(m[1]);
    }
  }

  // Match tool-name path patterns
  const toolMatches = text.matchAll(
    /\b(?:write|edit|read|create|update|modify|delete)\s+([^\s,;]+(?:\/[^\s,;]+)+)/gi,
  );
  for (const m of toolMatches) {
    if (isValidPath(m[1])) {
      paths.push(m[1]);
    }
  }

  return paths;
}

function isValidPath(p: string): boolean {
  // Filter out false positives: URLs, single chars, things that look like words
  if (p.startsWith("http://") || p.startsWith("https://")) return false;
  if (p.length < 3) return false;
  // Must contain a path separator or a file extension
  return p.includes("/") || /\.[a-z]{2,4}$/i.test(p);
}

function extractDecisions(text: string): string[] {
  const decisions: string[] = [];
  for (const pattern of DECISION_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) {
        const cleaned = m.trim().replace(/\s+/g, " ");
        if (cleaned.length > 10 && cleaned.length < 200) {
          decisions.push(cleaned);
        }
      }
    }
  }
  return decisions;
}

function extractNextSteps(text: string): string[] {
  const steps: string[] = [];
  for (const pattern of NEXT_STEP_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) {
        const cleaned = m.trim().replace(/\s+/g, " ");
        if (cleaned.length > 10 && cleaned.length < 200) {
          steps.push(cleaned);
        }
      }
    }
  }
  return steps;
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
  // Detect compaction summary by content patterns
  return (
    text.includes("[Compacted summary") ||
    text.includes("[Compaction Context") ||
    (m.name === "compaction-context" && true) ||
    (typeof m.id === "string" && m.id.startsWith("summary-"))
  );
}

function findLastAssistant(messages: MessageLike[]): MessageLike | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") return m;
  }
  return null;
}
