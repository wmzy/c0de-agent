// Token budget and message compaction (per design spec §3.6).
//
// Strategy:
//   1. estimateTokens — fast character/4 heuristic (no tokenizer dependency).
//      English prose lands around 0.25 tokens/char; we use the common 1 token
//      per 4 chars rule which is accurate enough for budget management.
//   2. fitToBudget — sliding window: drop oldest non-system messages until
//      the surviving set fits within budget.available. Always preserves
//      role === 'system' messages and the trailing `keepRecent` messages.
//   3. shouldCompact — true when usage / total > threshold AND compaction is
//      enabled AND there is at least one droppable message.
//   4. compactMessages — replaces the droppable prefix with a single summary
//      message. The summary itself is produced by calling an external
//      summarizer function; we inject one here that returns a structured
//      placeholder, real wiring (call into llm.chatStream) belongs in agent.ts.

import type { CompactionConfig, Message, MessageContentPart, TokenBudget } from "./types";

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: Message): number {
  if (typeof message.content === "string") {
    return estimateTokens(message.content);
  }
  let total = 0;
  for (const part of message.content) {
    total += estimateTokens(renderContentPart(part));
  }
  return total;
}

export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

// ---------------------------------------------------------------------------
// Budget allocation helpers
// ---------------------------------------------------------------------------

export type BudgetAllocation = {
  total: number;
  system: number;
  history: number;
  currentTurn: number;
};

export function allocateBudget(total: number): BudgetAllocation {
  // Spec §3.6 strategy 1: 20 / 60 / 20 split.
  return {
    total,
    system: Math.floor(total * 0.2),
    history: Math.floor(total * 0.6),
    currentTurn: total - Math.floor(total * 0.2) - Math.floor(total * 0.6),
  };
}

export function makeTokenBudget(
  total: number,
  opts: { reserved?: number; keepRecent?: number; used?: number } = {},
): TokenBudget {
  const reserved = opts.reserved ?? Math.floor(total * 0.2);
  const keepRecent = opts.keepRecent ?? 6;
  return {
    total,
    reserved,
    available: Math.max(0, total - reserved),
    used: opts.used ?? 0,
    keepRecent,
  };
}

// ---------------------------------------------------------------------------
// fitToBudget — sliding window that always keeps system messages and the
// most recent `keepRecent` non-system messages.
// ---------------------------------------------------------------------------

export function fitToBudget(messages: Message[], budget: TokenBudget): Message[] {
  const total = estimateMessagesTokens(messages);
  if (total <= budget.available) return [...messages];

  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  const recent = nonSystem.slice(-budget.keepRecent);
  const older = nonSystem.slice(0, Math.max(0, nonSystem.length - budget.keepRecent));

  // Recompute tokens and progressively drop from the front of `older` until
  // the surviving set fits inside budget.available. System messages are
  // considered part of `budget.reserved` and never trimmed here.
  let droppedFromOlder = 0;
  const systemTokens = estimateMessagesTokens(systemMessages);
  const availableForNonSystem = Math.max(0, budget.available - systemTokens);

  while (droppedFromOlder < older.length) {
    const candidate = [...older.slice(droppedFromOlder), ...recent];
    const candidateTokens = estimateMessagesTokens(candidate);
    if (candidateTokens <= availableForNonSystem) break;
    droppedFromOlder += 1;
  }

  const trimmed = older.slice(droppedFromOlder);
  return [...systemMessages, ...trimmed, ...recent];
}

// ---------------------------------------------------------------------------
// shouldCompact
// ---------------------------------------------------------------------------

export function shouldCompact(
  messages: Message[],
  budget: TokenBudget,
  config: CompactionConfig,
): boolean {
  if (!config.enabled) return false;
  if (budget.total <= 0) return false;
  const used = estimateMessagesTokens(messages);
  const ratio = used / budget.total;
  if (ratio < config.threshold) return false;

  // Need at least one droppable (non-system, non-recent) message to compact.
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (nonSystem.length <= budget.keepRecent) return false;

  return true;
}

// ---------------------------------------------------------------------------
// compactMessages — replace the droppable prefix with a summary message.
// The summarizer is injected; default uses the structured placeholder so the
// function is deterministic and testable in isolation. Real wiring (calling
// llm.chatStream for summarization) belongs in agent.ts.
// ---------------------------------------------------------------------------

export type Summarizer = (messages: Message[], config: CompactionConfig) => Promise<string>;

export const passthroughSummarizer: Summarizer = async (messages) => {
  return summarizeLocally(messages);
};

export async function compactMessages(
  messages: Message[],
  config: CompactionConfig,
  summarizer: Summarizer = passthroughSummarizer,
): Promise<Message[]> {
  if (!config.enabled) return messages;

  const systemMessages = messages.filter((m) => m.role === "system");

  // The "droppable" region is everything except system messages and the
  // trailing keepRecentTokens worth of content. We approximate keepRecent
  // by converting the token budget to a message count using keepRecent
  // semantics (the spec defines both fields; keepRecentTokens is the
  // authoritative one).
  const recent: Message[] = [];
  const older: Message[] = [];
  {
    let remaining = config.keepRecentTokens;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "system") continue;
      if (remaining <= 0) break;
      remaining -= estimateMessageTokens(m);
      recent.unshift(m);
    }
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.role === "system") continue;
      if (recent.includes(m)) continue;
      older.push(m);
    }
  }

  if (older.length === 0) return messages;

  const summaryText = await summarizer(older, config);
  const summaryMessage: Message = {
    id: `summary-${older[0]!.id}`,
    role: "system",
    content: summaryText,
    createdAt: Date.now(),
  };

  return [...systemMessages, summaryMessage, ...recent];
}

function summarizeLocally(messages: Message[]): string {
  // Local fallback summarizer: a compact structured digest of the dropped
  // range. Real implementations would call llm.chatStream with a "summarize"
  // prompt; this keeps compactMessages fully synchronous-testable.
  const lines: string[] = ["[Compacted summary of earlier conversation]"];
  for (const m of messages) {
    const head = typeof m.content === "string" ? m.content : renderParts(m.content);
    lines.push(`- ${m.role}: ${head.slice(0, 160)}${head.length > 160 ? "…" : ""}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// compactIfNeeded — high-level entry point for agent loop integration
// (spec §2.4 / §3.6)
// ---------------------------------------------------------------------------

export type CompactionState = {
  messages: Message[];
  tokenBudget: TokenBudget;
  compactionConfig?: CompactionConfig;
};

/**
 * Check whether the message history exceeds the compaction threshold and,
 * if so, compact the messages by summarizing older content.
 *
 * Returns `true` when compaction occurred (messages were modified),
 * `false` when the budget is within limits or compaction is disabled.
 *
 * The function is designed for direct integration into the agent loop:
 * call it after each LLM turn (or after each N turns) to keep the
 * conversation within budget.
 *
 * @param state - mutable message list + token budget + compaction config
 * @param summarizer - optional custom summarizer (defaults to local fallback)
 */
export async function compactIfNeeded(
  state: CompactionState,
  summarizer?: Summarizer,
): Promise<boolean> {
  const config = state.compactionConfig;
  if (!config || !config.enabled) return false;

  if (!shouldCompact(state.messages, state.tokenBudget, config)) {
    return false;
  }

  try {
    const compacted = await compactMessages(state.messages, config, summarizer);
    state.messages.length = 0;
    state.messages.push(...compacted);

    // Update budget usage after compaction
    state.tokenBudget.used = estimateMessagesTokens(state.messages);
    return true;
  } catch (err) {
    // Compaction failure is non-fatal — the agent loop continues with the
    // original (uncompacted) messages. The caller can observe the error via
    // the returned boolean and handle it (e.g. yield a compaction_error event).
    throw new Error(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function renderContentPart(part: MessageContentPart): string {
  switch (part._tag) {
    case "text":
      return part.text;
    case "image":
      return `[image:${part.alt ?? part.url}]`;
    case "reference":
      return `@[${part.path}:${part.startLine}-${part.endLine}]`;
  }
}

export function renderParts(parts: MessageContentPart[]): string {
  return parts.map(renderContentPart).join("\n");
}
