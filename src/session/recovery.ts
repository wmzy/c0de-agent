// Session recovery — detect and repair corrupted session data.
//
// recoverSession(db, sessionId) walks every message in the session, identifies
// corruption (broken JSON, malformed thinking blocks, orphaned references,
// duplicates, timestamp anomalies), and applies automatic repairs where safe.
// Manual intervention is flagged for issues that can't be auto-repaired.
//
// Data + functions, no class.  Follows the existing session module conventions.

import { asc, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { messages, sessions } from "../db/schema";
import type { MessageData, SessionData } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Classification of corruption found in a session. */
export type CorruptionType =
  | "missing_session"
  | "orphaned_messages"
  | "invalid_content"
  | "malformed_thinking"
  | "duplicate_messages"
  | "broken_metadata"
  | "stale_timestamps"
  | "missing_role"
  | "empty_content";

/** Severity of a single issue — warnings are informational, errors require action. */
export type CorruptionSeverity = "warning" | "error";

/** One discrete issue found during detection. */
export type CorruptionIssue = {
  type: CorruptionType;
  messageId?: string;
  description: string;
  severity: CorruptionSeverity;
  autoRecoverable: boolean;
};

/** Full report returned by detectCorruptedSession. */
export type CorruptionReport = {
  sessionId: string;
  corrupted: boolean;
  issues: CorruptionIssue[];
  detectedAt: Date;
};

/** How a specific recovery action was resolved. */
export type RecoveryAction = {
  type: CorruptionType;
  messageId?: string;
  description: string;
  applied: boolean;
};

/** Result of a full recovery attempt. */
export type RecoveryResult = {
  sessionId: string;
  recovered: boolean;
  actions: RecoveryAction[];
  unrecoverable: CorruptionIssue[];
  recoveredAt: Date;
};

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

/** A thinking block inside a content array (Anthropic / OpenAI extended format). */
type ThinkingBlock = {
  type: "thinking";
  thinking: string;
};

/** Any block inside a content array. */
type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  [key: string]: unknown;
};

/** Content can be a plain string or an array of blocks. */
type MessageContent = string | ContentBlock[] | unknown;

function isContentArray(content: MessageContent): content is ContentBlock[] {
  return Array.isArray(content);
}

function isThinkingBlock(block: ContentBlock): block is ContentBlock & { type: "thinking" } {
  return block.type === "thinking";
}

/** Check whether a thinking block is structurally valid. */
function isValidThinkingBlock(block: ContentBlock): boolean {
  if (block.type !== "thinking") return false;
  if (typeof block.thinking !== "string") return false;
  if (block.thinking.length === 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// detectCorruptedSession — public entry point
// ---------------------------------------------------------------------------

/**
 * Inspect every message in `sessionId` and return a corruption report.
 * Pure read — never modifies the database.
 */
export async function detectCorruptedSession(
  db: DB,
  sessionId: string,
): Promise<CorruptionReport> {
  const issues: CorruptionIssue[] = [];

  // 1. Does the session exist?
  const [session] = await db.db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!session) {
    return {
      sessionId,
      corrupted: true,
      issues: [
        {
          type: "missing_session",
          description: `Session ${sessionId} does not exist`,
          severity: "error",
          autoRecoverable: false,
        },
      ],
      detectedAt: new Date(),
    };
  }

  // 2. Check metadata integrity.
  const meta = session.metadata as Record<string, unknown> | null;
  if (meta !== null && typeof meta !== "object") {
    issues.push({
      type: "broken_metadata",
      description: "Session metadata is not a valid object",
      severity: "warning",
      autoRecoverable: true,
    });
  }

  // 3. Fetch all messages in order.
  const allMessages = await db.db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt));

  // 4. Detect duplicate message IDs.
  const seenIds = new Set<string>();
  for (const msg of allMessages) {
    if (seenIds.has(msg.id)) {
      issues.push({
        type: "duplicate_messages",
        messageId: msg.id,
        description: `Duplicate message id ${msg.id}`,
        severity: "error",
        autoRecoverable: true,
      });
    }
    seenIds.add(msg.id);
  }

  // 5. Per-message checks.
  for (const msg of allMessages) {
    // Role check
    if (!msg.role || typeof msg.role !== "string") {
      issues.push({
        type: "missing_role",
        messageId: msg.id,
        description: `Message ${msg.id} has no valid role`,
        severity: "error",
        autoRecoverable: false,
      });
    }

    // Content validity
    const contentIssue = detectContentIssue(msg.id, msg.content, session.createdAt);
    if (contentIssue) issues.push(contentIssue);

    // Timestamp sanity — message shouldn't be before session creation
    const timeIssue = detectTimestampIssue(msg.id, msg.createdAt, session.createdAt);
    if (timeIssue) issues.push(timeIssue);
  }

  // 6. Empty session check (warning, not error — some sessions legitimately start empty).
  if (allMessages.length === 0) {
    const age = Date.now() - new Date(session.createdAt).getTime();
    if (age > 60_000) {
      // Session older than 1 minute with zero messages is suspicious.
      issues.push({
        type: "empty_content",
        description: "Session has no messages despite being older than 1 minute",
        severity: "warning",
        autoRecoverable: false,
      });
    }
  }

  return {
    sessionId,
    corrupted: issues.some((i) => i.severity === "error") || issues.length > 0,
    issues,
    detectedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// detectContentIssue — internal helper
// ---------------------------------------------------------------------------

function detectContentIssue(
  messageId: string,
  content: unknown,
  sessionCreatedAt: Date,
): CorruptionIssue | null {
  // null / undefined content
  if (content === null || content === undefined) {
    return {
      type: "empty_content",
      messageId,
      description: `Message ${messageId} has null/undefined content`,
      severity: "warning",
      autoRecoverable: true,
    };
  }

  // Plain string content — always valid.
  if (typeof content === "string") return null;

  // Content array — check each block.
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) {
        return {
          type: "invalid_content",
          messageId,
          description: `Message ${messageId} contains non-object content block`,
          severity: "error",
          autoRecoverable: true,
        };
      }

      // Thinking block validation
      if (isThinkingBlock(block as ContentBlock)) {
        const cb = block as ContentBlock;
        if (!isValidThinkingBlock(cb)) {
          return {
            type: "malformed_thinking",
            messageId,
            description:
              cb.thinking === ""
                ? `Message ${messageId} has empty thinking block`
                : `Message ${messageId} has thinking block with invalid thinking field`,
            severity: "error",
            autoRecoverable: true,
          };
        }
      }

      // Block with no type at all
      if (!("type" in block)) {
        return {
          type: "invalid_content",
          messageId,
          description: `Message ${messageId} contains content block without type field`,
          severity: "error",
          autoRecoverable: true,
        };
      }
    }
    return null;
  }

  // Object that isn't an array and isn't a string — treat as serialized JSON gone wrong.
  if (typeof content === "object") {
    return {
      type: "invalid_content",
      messageId,
      description: `Message ${messageId} has unexpected object content (expected string or array)`,
      severity: "warning",
      autoRecoverable: false,
    };
  }

  return {
    type: "invalid_content",
    messageId,
    description: `Message ${messageId} has non-string/non-array content`,
    severity: "error",
    autoRecoverable: false,
  };
}

// ---------------------------------------------------------------------------
// detectTimestampIssue — internal helper
// ---------------------------------------------------------------------------

function detectTimestampIssue(
  messageId: string,
  messageCreatedAt: Date,
  sessionCreatedAt: Date,
): CorruptionIssue | null {
  const msgTime = new Date(messageCreatedAt).getTime();
  const sessTime = new Date(sessionCreatedAt).getTime();

  if (msgTime < sessTime) {
    return {
      type: "stale_timestamps",
      messageId,
      description: `Message ${messageId} created before its session`,
      severity: "warning",
      autoRecoverable: true,
    };
  }

  // Future timestamp (more than 5 minutes ahead to allow clock skew).
  if (msgTime > Date.now() + 300_000) {
    return {
      type: "stale_timestamps",
      messageId,
      description: `Message ${messageId} has a future timestamp`,
      severity: "warning",
      autoRecoverable: true,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// recoverSession — public entry point
// ---------------------------------------------------------------------------

/**
 * Detect and repair corruption in `sessionId`.  Returns a report of every
 * action taken and any issues that could not be auto-repaired.
 *
 * Recovery strategy:
 * 1. Remove duplicate messages (keep earliest).
 * 2. Strip malformed thinking blocks or convert invalid blocks to text.
 * 3. Fix null content → empty string.
 * 4. Fix broken metadata → empty object.
 * 5. Clamp timestamps that predate session creation.
 * 6. Skip issues that require manual intervention (missing role, missing session).
 */
export async function recoverSession(
  db: DB,
  sessionId: string,
): Promise<RecoveryResult> {
  const report = await detectCorruptedSession(db, sessionId);
  const actions: RecoveryAction[] = [];
  const unrecoverable: CorruptionIssue[] = [];

  // If session doesn't exist, nothing to recover.
  if (report.issues.some((i) => i.type === "missing_session")) {
    return {
      sessionId,
      recovered: false,
      actions: [],
      unrecoverable: report.issues,
      recoveredAt: new Date(),
    };
  }

  // Fetch session + all messages fresh (we'll mutate).
  const [session] = await db.db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session) {
    return {
      sessionId,
      recovered: false,
      actions: [],
      unrecoverable: report.issues,
      recoveredAt: new Date(),
    };
  }

  const allMessages = await db.db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt));

  // ── Step 1: Remove duplicate messages (keep earliest by createdAt). ──────
  const duplicateIssues = report.issues.filter((i) => i.type === "duplicate_messages");
  if (duplicateIssues.length > 0) {
    const seenIds = new Set<string>();
    const idsToDelete: string[] = [];
    for (const msg of allMessages) {
      if (seenIds.has(msg.id)) {
        idsToDelete.push(msg.id);
      }
      seenIds.add(msg.id);
    }
    for (const id of idsToDelete) {
      await db.db.delete(messages).where(eq(messages.id, id));
      actions.push({
        type: "duplicate_messages",
        messageId: id,
        description: `Removed duplicate message ${id}`,
        applied: true,
      });
    }
  }

  // ── Step 2: Repair per-message content issues. ───────────────────────────
  // Re-fetch after duplicate removal.
  const cleanMessages = await db.db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt));

  for (const msg of cleanMessages) {
    let needsUpdate = false;
    let newContent: unknown = msg.content;

    // 2a: Fix null/undefined content → empty string.
    if (msg.content === null || msg.content === undefined) {
      newContent = "";
      needsUpdate = true;
      actions.push({
        type: "empty_content",
        messageId: msg.id,
        description: `Replaced null content with empty string for message ${msg.id}`,
        applied: true,
      });
    }

    // 2b: Fix content arrays — repair thinking blocks and invalid blocks.
    if (Array.isArray(newContent)) {
      const repaired = repairContentArray(newContent, msg.id, actions);
      if (repaired !== newContent) {
        newContent = repaired;
        needsUpdate = true;
      }
    }

    // 2c: Fix timestamp if it predates session creation.
    const sessTime = new Date(session.createdAt).getTime();
    const msgTime = new Date(msg.createdAt).getTime();
    if (msgTime < sessTime) {
      await db.db
        .update(messages)
        .set({ createdAt: session.createdAt })
        .where(eq(messages.id, msg.id));
      actions.push({
        type: "stale_timestamps",
        messageId: msg.id,
        description: `Clamped message ${msg.id} timestamp to session creation time`,
        applied: true,
      });
    }

    // Write content back if changed.
    if (needsUpdate) {
      await db.db
        .update(messages)
        .set({ content: newContent as Record<string, unknown> })
        .where(eq(messages.id, msg.id));
    }
  }

  // ── Step 3: Fix broken metadata. ─────────────────────────────────────────
  const metaIssue = report.issues.find((i) => i.type === "broken_metadata");
  if (metaIssue) {
    await db.db
      .update(sessions)
      .set({ metadata: {} })
      .where(eq(sessions.id, sessionId));
    actions.push({
      type: "broken_metadata",
      description: "Reset broken session metadata to empty object",
      applied: true,
    });
  }

  // ── Step 4: Touch updatedAt to reflect recovery. ─────────────────────────
  if (actions.length > 0) {
    await db.db
      .update(sessions)
      .set({ updatedAt: new Date() })
      .where(eq(sessions.id, sessionId));
  }

  // Collect unrecoverable issues.
  for (const issue of report.issues) {
    if (!issue.autoRecoverable) {
      unrecoverable.push(issue);
    }
  }

  return {
    sessionId,
    recovered: actions.length > 0,
    actions,
    unrecoverable,
    recoveredAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// repairContentArray — internal helper
// ---------------------------------------------------------------------------

/**
 * Walk a content array and repair individual blocks.  Returns a new array
 * (or the same reference if nothing changed).
 */
function repairContentArray(
  blocks: ContentBlock[],
  messageId: string,
  actions: RecoveryAction[],
): ContentBlock[] {
  let changed = false;
  const result: ContentBlock[] = [];

  for (const block of blocks) {
    // Non-object block → convert to text block.
    if (typeof block !== "object" || block === null) {
      result.push({ type: "text", text: String(block) });
      actions.push({
        type: "invalid_content",
        messageId,
        description: `Converted non-object block to text in message ${messageId}`,
        applied: true,
      });
      changed = true;
      continue;
    }

    // Block without type → add "text" type.
    if (!("type" in block)) {
      result.push({ ...block, type: "text" });
      actions.push({
        type: "invalid_content",
        messageId,
        description: `Added missing type field to block in message ${messageId}`,
        applied: true,
      });
      changed = true;
      continue;
    }

    // Thinking block with empty/invalid thinking → strip it.
    if (isThinkingBlock(block) && !isValidThinkingBlock(block)) {
      // If there's a `thinking` key but it's empty string, strip the block entirely.
      // The user gets no benefit from an empty thinking block.
      actions.push({
        type: "malformed_thinking",
        messageId,
        description: `Removed malformed thinking block from message ${messageId}`,
        applied: true,
      });
      changed = true;
      // Don't push the block — skip it.
      continue;
    }

    result.push(block);
  }

  return changed ? result : blocks;
}

// ---------------------------------------------------------------------------
// Batch recovery
// ---------------------------------------------------------------------------

/**
 * Recover every corrupted session in the database.  Returns per-session
 * results.  Useful for startup-time integrity checks.
 */
export async function recoverAllSessions(
  db: DB,
): Promise<RecoveryResult[]> {
  const allSessions = await db.db.select().from(sessions);
  const results: RecoveryResult[] = [];

  for (const session of allSessions) {
    const report = await detectCorruptedSession(db, session.id);
    if (report.corrupted) {
      const result = await recoverSession(db, session.id);
      results.push(result);
    }
  }

  return results;
}
