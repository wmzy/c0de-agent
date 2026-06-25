// Tests for session squash — interactive, preview, rollback, log, and stats.
//
// Uses an ephemeral PGLite database per test.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDB, type DB } from "../db/client";
import { messages, sessions, squashArchives } from "../db/schema";
import type { MessageData } from "./types";
import { appendMessage, getMessages } from "./message";
import { createSession } from "./session";
import { eq } from "drizzle-orm";
import {
  squashRecent,
  squashInteractive,
  squashPreview,
  squashRollback,
  getSquashLog,
  getSquashStats,
  type SquashConfig,
  type SquashSummarizer,
  type SquashPreview,
} from "./squash";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: DB;
let sessionId: string;
const tempDirs: string[] = [];

beforeEach(async () => {
  const dir = `/tmp/squash-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  tempDirs.push(dir);
  db = await createDB({ driver: "pglite", dataDir: dir });
  const session = await createSession(db, "Squash Test Session");
  sessionId = session.id;
});

afterEach(async () => {
  try {
    await db.db.delete(squashArchives).where(eq(squashArchives.sessionId, sessionId));
    await db.db.delete(messages).where(eq(messages.sessionId, sessionId));
    await db.db.delete(sessions).where(eq(sessions.id, sessionId));
  } catch {
    // ignore cleanup errors
  }
});

function makeMessage(role: string, content: string): Omit<MessageData, "id" | "sessionId" | "createdAt"> {
  return { role, content };
}

async function addInteraction(userText: string, assistantText: string): Promise<void> {
  await appendMessage(db, sessionId, makeMessage("user", userText));
  await appendMessage(db, sessionId, makeMessage("assistant", assistantText));
}

async function addMessages(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await addInteraction(`user message ${i}`, `assistant response ${i}`);
  }
}

// A predictable summarizer for testing.
const testSummarizer: SquashSummarizer = async (msgs) => {
  const roles = msgs.map((m) => m.role).join(",");
  return `[Test summary of ${msgs.length} messages (${roles})]`;
};

// ---------------------------------------------------------------------------
// squashRecent — existing interface still works
// ---------------------------------------------------------------------------

describe("squashRecent", () => {
  it("squashes recent pairs and stores archive", async () => {
    await addMessages(6); // 12 messages total (6 user + 6 assistant)

    const result = await squashRecent(db, sessionId, 3, undefined, testSummarizer);

    expect(result).toBeDefined();
    expect(result.id).toBe(sessionId);

    // 12 original msgs (6 pairs) → 3 pairs squashed → 12 - 6 + 1 summary = 7 messages
    const remaining = await getMessages(db, sessionId);
    expect(remaining.length).toBe(7);

    // Archive should exist.
    const log = await getSquashLog(db, sessionId);
    expect(log.length).toBe(1);
    expect(log[0].messageCount).toBeGreaterThan(0);
  });

  it("returns session unchanged when too few messages", async () => {
    await addMessages(1); // 2 messages only
    const result = await squashRecent(db, sessionId, 2);
    expect(result.id).toBe(sessionId);

    const remaining = await getMessages(db, sessionId);
    expect(remaining).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// squashInteractive
// ---------------------------------------------------------------------------

describe("squashInteractive", () => {
  it("squashes a specified range and returns archive entry", async () => {
    await addMessages(6); // 12 messages, indices 0-11

    // Squash messages at indices 2-5 (second and third interaction pairs)
    const archive = await squashInteractive(db, sessionId, {
      range: { startIndex: 2, endIndex: 5 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });

    expect(archive).toBeDefined();
    expect(archive.sessionId).toBe(sessionId);
    expect(archive.messageCount).toBe(4); // 4 messages in range 2-5
    expect(archive.summary).toContain("[Test summary");
    expect(archive.messageIds).toHaveLength(4);

    // Remaining messages: 0-1 (2) + summary (1) + 6-11 (6) = 9
    const remaining = await getMessages(db, sessionId);
    expect(remaining).toHaveLength(2 + 1 + 6);
  });

  it("throws on invalid range", async () => {
    await addMessages(3);
    await expect(
      squashInteractive(db, sessionId, {
        range: { startIndex: -1, endIndex: 2 },
        config: { minMessages: 1 },
        summarizer: testSummarizer,
      }),
    ).rejects.toThrow("Invalid squash range");
  });

  it("throws on reversed range", async () => {
    await addMessages(3);
    await expect(
      squashInteractive(db, sessionId, {
        range: { startIndex: 5, endIndex: 2 },
        config: { minMessages: 1 },
        summarizer: testSummarizer,
      }),
    ).rejects.toThrow("Invalid squash range");
  });

  it("throws when range exceeds bounds", async () => {
    await addMessages(3); // 6 messages
    await expect(
      squashInteractive(db, sessionId, {
        range: { startIndex: 0, endIndex: 10 },
        config: { minMessages: 1 },
        summarizer: testSummarizer,
      }),
    ).rejects.toThrow("Invalid squash range");
  });

  it("throws when fewer messages than minimum", async () => {
    await addMessages(1); // 2 messages
    await expect(
      squashInteractive(db, sessionId, {
        range: { startIndex: 0, endIndex: 1 },
        config: { minMessages: 5 },
        summarizer: testSummarizer,
      }),
    ).rejects.toThrow("minimum is 5");
  });
});

// ---------------------------------------------------------------------------
// squashPreview
// ---------------------------------------------------------------------------

describe("squashPreview", () => {
  it("returns preview without modifying database", async () => {
    await addMessages(4); // 8 messages, indices 0-7

    const before = await getMessages(db, sessionId);
    expect(before).toHaveLength(8);

    const preview = await squashPreview(db, sessionId, { startIndex: 2, endIndex: 5 }, testSummarizer);

    // Verify preview content.
    expect(preview.range).toEqual({ startIndex: 2, endIndex: 5 });
    expect(preview.messageCount).toBe(4);
    expect(preview.previewSummary).toContain("[Test summary");
    expect(preview.previewSummary).toContain("user");
    expect(preview.previewSummary).toContain("assistant");
    expect(preview.messages).toHaveLength(4);
    expect(preview.estimatedTokensSaved).toBeGreaterThan(0);

    // Database must be untouched.
    const after = await getMessages(db, sessionId);
    expect(after).toHaveLength(8);
    expect(after[2].content).toBe(before[2].content);
    expect(after[5].content).toBe(before[5].content);
  });

  it("throws on invalid preview range", async () => {
    await addMessages(2);
    await expect(
      squashPreview(db, sessionId, { startIndex: 0, endIndex: 10 }),
    ).rejects.toThrow("Invalid preview range");
  });

  it("returns zero token estimate for empty content messages", async () => {
    await appendMessage(db, sessionId, makeMessage("user", ""));
    await appendMessage(db, sessionId, makeMessage("assistant", ""));

    const preview = await squashPreview(db, sessionId, { startIndex: 0, endIndex: 1 }, testSummarizer);
    expect(preview.estimatedTokensSaved).toBe(0);
    expect(preview.messageCount).toBe(2);
  });

  it("preview is consistent with actual squash", async () => {
    await addMessages(4);

    // Get preview.
    const preview = await squashPreview(db, sessionId, { startIndex: 0, endIndex: 3 }, testSummarizer);

    // Actually squash.
    const archive = await squashInteractive(db, sessionId, {
      range: { startIndex: 0, endIndex: 3 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });

    // Preview summary should match archived summary.
    expect(preview.previewSummary).toBe(archive.summary);
    expect(preview.messageCount).toBe(archive.messageCount);
  });
});

// ---------------------------------------------------------------------------
// squashRollback
// ---------------------------------------------------------------------------

describe("squashRollback", () => {
  it("restores squashed messages and removes summary", async () => {
    await addMessages(4); // 8 messages

    const originalMessages = await getMessages(db, sessionId);
    expect(originalMessages).toHaveLength(8);

    // Squash the first 4 messages.
    const archive = await squashInteractive(db, sessionId, {
      range: { startIndex: 0, endIndex: 3 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });

    let afterSquash = await getMessages(db, sessionId);
    expect(afterSquash).toHaveLength(8 - 4 + 1); // 8 - 4 squashed + 1 summary = 5
    expect(afterSquash.some((m) => m.role === "system")).toBe(true);

    // Rollback.
    const rollback = await squashRollback(db, sessionId, archive.id);
    expect(rollback.applied).toBe(true);
    expect(rollback.restoredCount).toBe(4);
    expect(rollback.summaryMessageId).toBe(archive.summaryMessageId);

    // Messages should be restored.
    const afterRollback = await getMessages(db, sessionId);
    expect(afterRollback).toHaveLength(8);
    expect(afterRollback.some((m) => m.role === "system")).toBe(false);

    // Check original content preserved.
    for (let i = 0; i < 4; i++) {
      expect(afterRollback[i].content).toBe(originalMessages[i].content);
      expect(afterRollback[i].role).toBe(originalMessages[i].role);
    }
  });

  it("marks archive as rolled back", async () => {
    await addMessages(2);
    const archive = await squashInteractive(db, sessionId, {
      range: { startIndex: 0, endIndex: 3 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });

    await squashRollback(db, sessionId, archive.id);

    const log = await getSquashLog(db, sessionId);
    expect(log[0].rollbackApplied).toBe(true);
    expect(log[0].rollbackTimestamp).toBeInstanceOf(Date);
  });

  it("throws when rolling back an already-rolled-back archive", async () => {
    await addMessages(2);
    const archive = await squashInteractive(db, sessionId, {
      range: { startIndex: 0, endIndex: 3 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });
    await squashRollback(db, sessionId, archive.id);

    await expect(squashRollback(db, sessionId, archive.id)).rejects.toThrow(
      "has already been rolled back",
    );
  });

  it("throws for non-existent archive", async () => {
    await expect(squashRollback(db, sessionId, crypto.randomUUID())).rejects.toThrow(
      "Squash archive not found",
    );
  });
});

// ---------------------------------------------------------------------------
// getSquashLog
// ---------------------------------------------------------------------------

describe("getSquashLog", () => {
  it("returns empty array when no squashes performed", async () => {
    const log = await getSquashLog(db, sessionId);
    expect(log).toEqual([]);
  });

  it("returns ordered log entries", async () => {
    await addMessages(8);
    const a1 = await squashInteractive(db, sessionId, {
      range: { startIndex: 0, endIndex: 3 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });

    const a2 = await squashInteractive(db, sessionId, {
      range: { startIndex: 4, endIndex: 7 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });

    const log = await getSquashLog(db, sessionId);
    expect(log).toHaveLength(2);
    expect(log[0].id).toBe(a1.id);
    expect(log[1].id).toBe(a2.id);
    expect(log[0].summary).toContain("[Test summary");
    expect(log[0].messageCount).toBe(4);
  });

  it("includes rollback status in log entries", async () => {
    await addMessages(2);
    const archive = await squashInteractive(db, sessionId, {
      range: { startIndex: 0, endIndex: 3 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });

    const log = await getSquashLog(db, sessionId);
    expect(log[0].rollbackApplied).toBe(false);

    await squashRollback(db, sessionId, archive.id);
    const log2 = await getSquashLog(db, sessionId);
    expect(log2[0].rollbackApplied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getSquashStats
// ---------------------------------------------------------------------------

describe("getSquashStats", () => {
  it("returns zero stats when no squashes", async () => {
    const stats = await getSquashStats(db, sessionId);
    expect(stats).toEqual({
      totalSquashes: 0,
      totalMessagesSquashed: 0,
      totalTokensSaved: 0,
      rollbacksPerformed: 0,
      lastSquashTimestamp: null,
      averageMessagesPerSquash: 0,
    });
  });

  it("aggregates stats across multiple squashes", async () => {
    await addMessages(10); // 20 messages

    // Squash two ranges.
    await squashInteractive(db, sessionId, {
      range: { startIndex: 0, endIndex: 3 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });

    await squashInteractive(db, sessionId, {
      range: { startIndex: 4, endIndex: 7 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });

    const stats = await getSquashStats(db, sessionId);
    expect(stats.totalSquashes).toBe(2);
    expect(stats.totalMessagesSquashed).toBe(8); // 4 + 4
    expect(stats.totalTokensSaved).toBeGreaterThan(0);
    expect(stats.rollbacksPerformed).toBe(0);
    expect(stats.lastSquashTimestamp).toBeInstanceOf(Date);
    expect(stats.averageMessagesPerSquash).toBe(4);
  });

  it("counts rollbacks in stats", async () => {
    await addMessages(4);
    const archive = await squashInteractive(db, sessionId, {
      range: { startIndex: 0, endIndex: 3 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });
    await squashRollback(db, sessionId, archive.id);

    const stats = await getSquashStats(db, sessionId);
    expect(stats.totalSquashes).toBe(1);
    expect(stats.rollbacksPerformed).toBe(1);
  });

  it("reports accurate average messages per squash", async () => {
    await addMessages(10);
    await squashInteractive(db, sessionId, {
      range: { startIndex: 0, endIndex: 3 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });
    await squashInteractive(db, sessionId, {
      range: { startIndex: 4, endIndex: 9 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });

    const stats = await getSquashStats(db, sessionId);
    expect(stats.averageMessagesPerSquash).toBe(5); // (4 + 6) / 2
  });
});

// ---------------------------------------------------------------------------
// idempotency and edge cases
// ---------------------------------------------------------------------------

describe("squash edge cases", () => {
  it("multiple squashes on disjoint ranges work correctly", async () => {
    await addMessages(8); // 16 messages

    // Squash first 4, then remaining 4.
    const a1 = await squashInteractive(db, sessionId, {
      range: { startIndex: 0, endIndex: 3 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });
    const a2 = await squashInteractive(db, sessionId, {
      range: { startIndex: 4, endIndex: 7 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });

    // After first squash: indices 0-3 replaced by summary at index 0
    // Second squash: indices 4-7 (now shifted) → summary2 at index 1
    // Result: summary1 + summary2 + messages 8-15 = 10 messages
    const remaining = await getMessages(db, sessionId);
    expect(remaining).toHaveLength(8 + 2); // 8 pairs → 2 summaries
    const systemMsgs = remaining.filter((m) => m.role === "system");
    expect(systemMsgs).toHaveLength(2);
  });

  it("single message pair squash works", async () => {
    await addMessages(3); // 6 messages
    const archive = await squashInteractive(db, sessionId, {
      range: { startIndex: 0, endIndex: 1 },
      config: { minMessages: 1 },
      summarizer: testSummarizer,
    });
    expect(archive.messageCount).toBe(2);
  });

  it("squash uses custom summarizer correctly", async () => {
    await addMessages(2);
    const customSummarizer: SquashSummarizer = async () => "CUSTOM_SUMMARY";

    const archive = await squashInteractive(db, sessionId, {
      range: { startIndex: 0, endIndex: 3 },
      config: { minMessages: 1, summaryModel: "test-model" },
      summarizer: customSummarizer,
    });
    expect(archive.summary).toBe("CUSTOM_SUMMARY");
  });
});