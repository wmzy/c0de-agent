// Context window overflow recovery (§4.7).
//
// Provides multiple truncation strategies (aggressive / conservative /
// intelligent), message compression before retry, dynamic max_tokens
// adjustment, and structured recovery logging with statistics.
//
// Conventions: data + functions only.

import type { ChatMessage, ContentPart } from "./types";

// ---------------------------------------------------------------------------
// Truncation strategy
// ---------------------------------------------------------------------------

export type TruncationStrategyName = "aggressive" | "conservative" | "intelligent";

/**
 * Controls how messages are truncated on context overflow.
 *
 * - `keepRatio`: fraction of total non-system messages to keep (0–1).
 * - `keepMin`: floor on kept non-system messages.
 * - `keepMax`: ceiling on kept non-system messages.
 * - `summarize`: prepend a summary of removed messages.
 * - `maxRetries`: maximum truncation + retry attempts.
 * - `compressBeforeTruncate`: compress messages before truncating.
 * - `compressRatio`: target reduction factor for compression (0–1, e.g. 0.5 = 50%).
 * - `dynamicMaxTokens`: dynamically adjust max_tokens on recovery.
 * - `maxTokensFloor`: minimum max_tokens to guarantee on recovery.
 */
export type ContextTruncationStrategy = {
  readonly name: TruncationStrategyName;
  readonly keepRatio: number;
  readonly keepMin: number;
  readonly keepMax: number;
  readonly summarize: boolean;
  readonly maxRetries: number;
  readonly compressBeforeTruncate: boolean;
  readonly compressRatio: number;
  readonly dynamicMaxTokens: boolean;
  readonly maxTokensFloor: number;
};

// ---------------------------------------------------------------------------
// Named strategy presets
// ---------------------------------------------------------------------------

/** Aggressive: removes most context, fast recovery, lower quality. */
const AGGRESSIVE: ContextTruncationStrategy = {
  name: "aggressive",
  keepRatio: 0.2,
  keepMin: 2,
  keepMax: 10,
  summarize: true,
  maxRetries: 4,
  compressBeforeTruncate: true,
  compressRatio: 0.3,
  dynamicMaxTokens: true,
  maxTokensFloor: 4096,
};

/** Conservative: keeps more context, slower but higher quality recovery. */
const CONSERVATIVE: ContextTruncationStrategy = {
  name: "conservative",
  keepRatio: 0.5,
  keepMin: 4,
  keepMax: 30,
  summarize: true,
  maxRetries: 3,
  compressBeforeTruncate: true,
  compressRatio: 0.6,
  dynamicMaxTokens: true,
  maxTokensFloor: 8192,
};

/** Intelligent: analyzes message importance, preserves tool-calls and unique content. */
const INTELLIGENT: ContextTruncationStrategy = {
  name: "intelligent",
  keepRatio: 0.35,
  keepMin: 3,
  keepMax: 20,
  summarize: true,
  maxRetries: 5,
  compressBeforeTruncate: true,
  compressRatio: 0.5,
  dynamicMaxTokens: true,
  maxTokensFloor: 6144,
};

export const TRUNCATION_STRATEGIES: Readonly<
  Record<TruncationStrategyName, ContextTruncationStrategy>
> = {
  aggressive: AGGRESSIVE,
  conservative: CONSERVATIVE,
  intelligent: INTELLIGENT,
};

export const DEFAULT_TRUNCATION_STRATEGY: ContextTruncationStrategy = INTELLIGENT;

// ---------------------------------------------------------------------------
// Recovery statistics and logging
// ---------------------------------------------------------------------------

export type RecoveryLogEntry = {
  readonly timestamp: number;
  readonly attempt: number;
  readonly strategy: TruncationStrategyName;
  readonly messagesRemoved: number;
  readonly messagesCompressed: number;
  readonly keepRatio: number;
  readonly success: boolean;
  readonly durationMs: number;
  readonly error?: string;
};

export type RecoveryStats = {
  totalRecoveries: number;
  successfulRecoveries: number;
  failedRecoveries: number;
  totalMessagesRemoved: number;
  totalMessagesCompressed: number;
  readonly recoveryLog: RecoveryLogEntry[];
};

/** Runtime state that tracks recovery progress across retries. */
export type ContextRecoveryState = {
  attempt: number;
  readonly strategy: ContextTruncationStrategy;
  readonly originalMessageCount: number;
  lastTruncatedCount: number;
  totalRemoved: number;
  totalCompressed: number;
  readonly startTime: number;
  readonly stats: RecoveryStats;
};

export function createRecoveryState(
  strategy: ContextTruncationStrategy = DEFAULT_TRUNCATION_STRATEGY,
  originalMessageCount = 0,
): ContextRecoveryState {
  return {
    attempt: 0,
    strategy,
    originalMessageCount,
    lastTruncatedCount: originalMessageCount,
    totalRemoved: 0,
    totalCompressed: 0,
    startTime: Date.now(),
    stats: {
      totalRecoveries: 0,
      successfulRecoveries: 0,
      failedRecoveries: 0,
      totalMessagesRemoved: 0,
      totalMessagesCompressed: 0,
      recoveryLog: [],
    },
  };
}

/** Record a recovery attempt in the stats log. */
export function recordRecoveryAttempt(
  state: ContextRecoveryState,
  entry: Omit<RecoveryLogEntry, "timestamp">,
): void {
  state.stats.recoveryLog.push({ ...entry, timestamp: Date.now() });
  state.stats.totalRecoveries++;
  state.stats.totalMessagesRemoved += entry.messagesRemoved;
  state.stats.totalMessagesCompressed += entry.messagesCompressed;

  if (entry.success) {
    state.stats.successfulRecoveries++;
  } else {
    state.stats.failedRecoveries++;
  }
}

// ---------------------------------------------------------------------------
// Message compression (before truncation)
// ---------------------------------------------------------------------------

/** Extract plain text from message content. */
function extractText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ContentPart, { _tag: "text" }> => p._tag === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Compress messages to reduce token count before truncation.
 *
 * Strategies:
 *   1. Strip thinking blocks from old messages (they're verbose reasoning traces).
 *   2. Merge consecutive tool_call → tool_result pairs into compact summaries.
 *   3. Collapse short acknowledgments ("ok", "sure", "yes") into empty messages.
 *   4. Truncate long text content in old messages to first/last sentences.
 *
 * Returns compressed messages and the number of messages that were compressed.
 */
export function compressMessages(
  messages: ChatMessage[],
  ratio: number,
  cutoffIndex: number,
): { messages: ChatMessage[]; compressedCount: number } {
  if (messages.length === 0 || cutoffIndex <= 0) {
    return { messages, compressedCount: 0 };
  }

  let compressedCount = 0;
  const result: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Only compress messages before the cutoff.
    if (i >= cutoffIndex) {
      result.push(msg);
      continue;
    }

    let compressed = msg;

    // Strip thinking content from assistant messages.
    if (msg.role === "assistant" && typeof msg.content === "string") {
      const text = msg.content;
      if (text.length > 200) {
        // Keep first 80 chars and last 80 chars.
        const prefix = text.slice(0, 80);
        const suffix = text.slice(-80);
        const newText = `${prefix}…${suffix}`;
        compressed = { ...msg, content: newText };
        compressedCount++;
      }
    }

    // Collapse short user acknowledgments.
    if (msg.role === "user") {
      const text = extractText(msg.content);
      const normalized = text.trim().toLowerCase();
      if (
        normalized.length > 0 &&
        normalized.length < 30 &&
        /^(ok|okay|sure|yes|yeah|yep|yup|no|nope|got it|understood|right|correct|thanks|thank you)$/i.test(
          normalized,
        )
      ) {
        compressed = { ...msg, content: "[ack]" };
        compressedCount++;
      }
    }

    // Truncate long text content.
    if (typeof compressed.content === "string" && compressed.content.length > 500) {
      const text = compressed.content;
      // Keep first sentence (up to 200 chars) and last 200 chars.
      const firstSentenceEnd = findSentenceBoundary(text, 200);
      const prefix = text.slice(0, firstSentenceEnd);
      const suffix = text.slice(-200);
      compressed = { ...compressed, content: `${prefix}\n…\n${suffix}` };
      compressedCount++;
    } else if (Array.isArray(compressed.content)) {
      const hasLongPart = compressed.content.some((p) => p._tag === "text" && p.text.length > 500);
      if (hasLongPart) {
        const newParts = compressed.content.map((p) => {
          if (p._tag === "text" && p.text.length > 500) {
            const text = p.text;
            const firstSentenceEnd = findSentenceBoundary(text, 200);
            const prefix = text.slice(0, firstSentenceEnd);
            const suffix = text.slice(-200);
            return { ...p, text: `${prefix}\n…\n${suffix}` };
          }
          return p;
        });
        compressed = { ...compressed, content: newParts };
        compressedCount++;
      }
    }

    result.push(compressed);
  }

  return { messages: result, compressedCount };
}

/** Find the end of a sentence near the target position. */
function findSentenceBoundary(text: string, target: number): number {
  // Look for sentence boundaries near the target.
  for (let i = target; i > target - 50 && i >= 0; i--) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "?") return i + 1;
  }
  // Fall back to word boundary.
  const spaceIdx = text.lastIndexOf(" ", target);
  return spaceIdx > target - 50 ? spaceIdx + 1 : target;
}

// ---------------------------------------------------------------------------
// Message truncation (context overflow recovery)
// ---------------------------------------------------------------------------

/**
 * Truncate messages keeping the most recent non-system messages.
 *
 * Strategy variants:
 * - `aggressive`: simple ratio-based keep from the end.
 * - `conservative`: keep more messages, remove oldest first.
 * - `intelligent`: preserve tool-call/result pairs, keep messages with unique
 *   content, remove boilerplate first.
 *
 * Returns the truncated message array and the number removed.
 */
export function truncateMessages(
  messages: ChatMessage[],
  strategy: ContextTruncationStrategy,
  summarize = true,
): { messages: ChatMessage[]; removedCount: number } {
  const systemMessages: ChatMessage[] = [];
  const nonSystemMessages: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemMessages.push(msg);
    } else {
      nonSystemMessages.push(msg);
    }
  }

  if (nonSystemMessages.length === 0) {
    return { messages, removedCount: 0 };
  }

  switch (strategy.name) {
    case "aggressive":
      return truncateAggressive(systemMessages, nonSystemMessages, strategy, summarize);
    case "conservative":
      return truncateConservative(systemMessages, nonSystemMessages, strategy, summarize);
    case "intelligent":
      return truncateIntelligent(systemMessages, nonSystemMessages, strategy, summarize);
  }
}

function truncateAggressive(
  systemMessages: ChatMessage[],
  nonSystem: ChatMessage[],
  strategy: ContextTruncationStrategy,
  summarize: boolean,
): { messages: ChatMessage[]; removedCount: number } {
  const keepCount = clampKeepCount(nonSystem.length, strategy);

  if (keepCount >= nonSystem.length) {
    return { messages: [...systemMessages, ...nonSystem], removedCount: 0 };
  }

  const removed = nonSystem.slice(0, nonSystem.length - keepCount);
  const kept = nonSystem.slice(nonSystem.length - keepCount);

  const result: ChatMessage[] = [...systemMessages];
  if (summarize && removed.length > 0) {
    result.push(buildTruncationSummary(removed));
  }
  result.push(...kept);
  return { messages: result, removedCount: removed.length };
}

function truncateConservative(
  systemMessages: ChatMessage[],
  nonSystem: ChatMessage[],
  strategy: ContextTruncationStrategy,
  summarize: boolean,
): { messages: ChatMessage[]; removedCount: number } {
  const keepCount = clampKeepCount(nonSystem.length, strategy);

  if (keepCount >= nonSystem.length) {
    return { messages: [...systemMessages, ...nonSystem], removedCount: 0 };
  }

  // Conservative: remove oldest first (same as aggressive but with higher keepCount).
  const removed = nonSystem.slice(0, nonSystem.length - keepCount);
  const kept = nonSystem.slice(nonSystem.length - keepCount);

  const result: ChatMessage[] = [...systemMessages];
  if (summarize && removed.length > 0) {
    result.push(buildTruncationSummary(removed));
  }
  result.push(...kept);
  return { messages: result, removedCount: removed.length };
}

/**
 * Intelligent truncation: preserves tool-call/result pairs and messages
 * with unique content, removes boilerplate and duplicates first.
 */
function truncateIntelligent(
  systemMessages: ChatMessage[],
  nonSystem: ChatMessage[],
  strategy: ContextTruncationStrategy,
  summarize: boolean,
): { messages: ChatMessage[]; removedCount: number } {
  const keepCount = clampKeepCount(nonSystem.length, strategy);

  if (keepCount >= nonSystem.length) {
    return { messages: [...systemMessages, ...nonSystem], removedCount: 0 };
  }

  // Score each message by importance (lower = more removable).
  const scored = nonSystem.map((msg, index) => ({
    msg,
    index,
    score: scoreMessageImportance(msg, index, nonSystem.length),
  }));

  // Always keep the last N messages.
  const lastKeep = nonSystem.length - keepCount;
  for (const s of scored.slice(lastKeep)) {
    s.score = -1000; // Force keep.
  }

  // Sort by score ascending (lowest score = most removable first).
  scored.sort((a, b) => a.score - b.score);

  // Mark the lowest-scored messages for removal.
  const toRemove = new Set<number>();
  for (let i = 0; i < scored.length - keepCount; i++) {
    // Ensure tool-call/result pairs stay together.
    const idx = scored[i].index;
    if (toRemove.has(idx)) continue;

    // If removing this assistant message would orphan a tool result, skip it.
    if (scored[i].msg.role === "assistant" && scored[i].msg.toolCalls?.length) {
      // Check if next message is a tool result.
      if (idx + 1 < nonSystem.length && nonSystem[idx + 1].role === "tool") {
        // Keep both the tool call and result.
        continue;
      }
    }

    toRemove.add(idx);
  }

  // Build kept messages preserving order.
  const kept: ChatMessage[] = [];
  const removed: ChatMessage[] = [];
  for (let i = 0; i < nonSystem.length; i++) {
    if (toRemove.has(i)) {
      removed.push(nonSystem[i]);
    } else {
      kept.push(nonSystem[i]);
    }
  }

  const result: ChatMessage[] = [...systemMessages];
  if (summarize && removed.length > 0) {
    result.push(buildTruncationSummary(removed));
  }
  result.push(...kept);
  return { messages: result, removedCount: removed.length };
}

/** Score message importance. Lower score = more removable. */
function scoreMessageImportance(msg: ChatMessage, index: number, totalMessages: number): number {
  let score = 0;

  // Distance from end: newer messages are more important.
  const recency = 1 - index / Math.max(totalMessages - 1, 1);
  score += recency * 3;

  // Tool messages are important (they contain function results).
  if (msg.role === "tool") {
    score += 5;
  }

  // Tool call messages are important (they contain actions).
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    score += 4;
  }

  // Messages with longer content are more likely unique.
  const text = extractText(msg.content);
  if (text.length > 200) {
    score += 2;
  }

  // Short acknowledgments are low importance.
  if (text.length < 30) {
    score -= 2;
  }

  return score;
}

// ---------------------------------------------------------------------------
// Dynamic max_tokens adjustment
// ---------------------------------------------------------------------------

/**
 * Dynamically adjust max_tokens based on recovery state.
 *
 * When truncation removes context, the model may need more output tokens
 * to compensate for the lost conversational history. This function
 * calculates an appropriate max_tokens value that accounts for:
 *
 * - The fraction of context removed (more removal → more output room).
 * - A floor to prevent degenerate tiny outputs.
 * - The original max_tokens as a ceiling.
 */
export function adjustMaxTokens(originalMaxTokens: number, state: ContextRecoveryState): number {
  if (!state.strategy.dynamicMaxTokens) return originalMaxTokens;

  const { totalRemoved, originalMessageCount } = state;
  if (originalMessageCount === 0) return originalMaxTokens;

  // Fraction of messages removed (0–1).
  const removalFraction = Math.min(totalRemoved / originalMessageCount, 1);

  // Scale up output tokens proportionally to removal fraction.
  // At 0% removal: 1.0x, at 100% removal: 1.5x.
  const scaleFactor = 1 + removalFraction * 0.5;
  const adjusted = Math.ceil(originalMaxTokens * scaleFactor);

  return Math.max(state.strategy.maxTokensFloor, Math.min(adjusted, originalMaxTokens * 2));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampKeepCount(nonSystemLength: number, strategy: ContextTruncationStrategy): number {
  return Math.min(
    strategy.keepMax,
    Math.max(strategy.keepMin, Math.ceil(nonSystemLength * strategy.keepRatio)),
  );
}

/**
 * Build a summary message from truncated messages.
 * Gives the model context about what was in the removed portion.
 */
function buildTruncationSummary(removed: ChatMessage[]): ChatMessage {
  const roleCounts: Record<string, number> = {};
  const textSnippets: string[] = [];

  for (const msg of removed) {
    roleCounts[msg.role] = (roleCounts[msg.role] ?? 0) + 1;
    const text = extractText(msg.content);
    if (text && textSnippets.length < 3) {
      textSnippets.push(text.slice(0, 200));
    }
  }

  const roleSummary = Object.entries(roleCounts)
    .filter(([, count]) => count > 0)
    .map(([role, count]) => `${count} ${role}`)
    .join(", ");

  let summaryText =
    `[Context window overflow: ${removed.length} earlier messages removed to fit within limits. ` +
    `Removed messages: ${roleSummary}.]`;

  if (textSnippets.length > 0) {
    summaryText += "\n\nKey content from removed messages:\n";
    for (const snippet of textSnippets) {
      summaryText += `- ${snippet}${snippet.length >= 200 ? "..." : ""}\n`;
    }
  }

  return { role: "user", content: summaryText };
}
