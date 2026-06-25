// Tests for session recovery — detect and repair corrupted sessions.
//
// Corrupt data is inserted via raw SQL to bypass Drizzle NOT NULL / PK
// constraints, simulating real-world PGLite WAL corruption or migration bugs.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDB, type DB } from "../db/client";
import type { MessageData } from "./types";
import {
  detectCorruptedSession,
  recoverSession,
  recoverAllSessions,
} from "./recovery";
import { appendMessage, getMessages } from "./message";
import { createSession } from "./session";
import { eq, sql } from "drizzle-orm";
import { messages, sessions } from "../db/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: DB;
let sessionId: string;
const tempDirs: string[] = [];

beforeEach(async () => {
  const dir = `/tmp/recovery-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  tempDirs.push(dir);
  db = await createDB({ driver: "pglite", dataDir: dir });
  const session = await createSession(db, "Test Session");
  sessionId = session.id;
});

afterEach(async () => {
  // Best-effort cleanup.
  try {
    await db.db.delete(messages).where(eq(messages.sessionId, sessionId));
    await db.db.delete(sessions).where(eq(sessions.id, sessionId));
  } catch {
    // ignore cleanup errors
  }
});

function makeMessage(
  role: string,
  content: string | unknown[],
): Omit<MessageData, "id" | "sessionId" | "createdAt"> {
  return { role, content: content as string };
}

/** Insert a message bypassing NOT NULL via raw SQL (simulates corruption). */
async function insertCorruptMessage(
  id: string,
  sessId: string,
  role: string,
  content: unknown,
  createdAt?: Date,
) {
  await db.db.execute(sql`
    INSERT INTO messages (id, session_id, role, content, token_count, created_at)
    OVERRIDING SYSTEM VALUE
    VALUES (${id}::uuid, ${sessId}::uuid, ${role}, ${JSON.stringify(content)}::jsonb, 0, ${createdAt ?? new Date()})
  `);
}

/** Insert a raw row with specific id (for duplicates, via second id). */
async function insertRawMessage(
  id: string,
  sessId: string,
  role: string,
  content: string,
  createdAt: Date,
) {
  await db.db.execute(sql`
    INSERT INTO messages (id, session_id, role, content, token_count, created_at)
    OVERRIDING SYSTEM VALUE
    VALUES (${id}::uuid, ${sessId}::uuid, ${role}, ${content}::jsonb, 0, ${createdAt})
  `);
}

// ---------------------------------------------------------------------------
// detectCorruptedSession
// ---------------------------------------------------------------------------

describe("detectCorruptedSession", () => {
  it("returns not corrupted for a healthy session", async () => {
    await appendMessage(db, sessionId, makeMessage("user", "hello"));
    await appendMessage(db, sessionId, makeMessage("assistant", "hi there"));

    const report = await detectCorruptedSession(db, sessionId);
    expect(report.corrupted).toBe(false);
    expect(report.issues).toHaveLength(0);
  });

  it("detects missing session (valid UUID that doesn't exist)", async () => {
    const fakeId = crypto.randomUUID();
    const report = await detectCorruptedSession(db, fakeId);
    expect(report.corrupted).toBe(true);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].type).toBe("missing_session");
    expect(report.issues[0].autoRecoverable).toBe(false);
  });

  it("detects null content via raw SQL insert", async () => {
    const msgId = crypto.randomUUID();
    await insertCorruptMessage(msgId, sessionId, "user", null);

    const report = await detectCorruptedSession(db, sessionId);
    expect(report.corrupted).toBe(true);
    const contentIssues = report.issues.filter((i) => i.type === "empty_content");
    expect(contentIssues.length).toBeGreaterThanOrEqual(1);
    expect(contentIssues[0].messageId).toBe(msgId);
  });

  it("detects malformed thinking blocks", async () => {
    const contentArray = [
      { type: "thinking", thinking: "" }, // empty thinking = invalid
      { type: "text", text: "hello" },
    ];
    await appendMessage(db, sessionId, makeMessage("assistant", contentArray));

    const report = await detectCorruptedSession(db, sessionId);
    expect(report.corrupted).toBe(true);
    const thinkingIssues = report.issues.filter((i) => i.type === "malformed_thinking");
    expect(thinkingIssues.length).toBe(1);
    expect(thinkingIssues[0].autoRecoverable).toBe(true);
  });

  it("detects thinking blocks with non-string thinking field", async () => {
    const contentArray = [
      { type: "thinking", thinking: 123 }, // not a string
      { type: "text", text: "hello" },
    ];
    await appendMessage(db, sessionId, makeMessage("assistant", contentArray));

    const report = await detectCorruptedSession(db, sessionId);
    expect(report.corrupted).toBe(true);
    expect(report.issues.some((i) => i.type === "malformed_thinking")).toBe(true);
  });

  it("detects content blocks without type field", async () => {
    const contentArray = [{ text: "hello" }]; // no type
    await appendMessage(db, sessionId, makeMessage("assistant", contentArray));

    const report = await detectCorruptedSession(db, sessionId);
    expect(report.corrupted).toBe(true);
    const invalidContent = report.issues.filter((i) => i.type === "invalid_content");
    expect(invalidContent.length).toBe(1);
    expect(invalidContent[0].autoRecoverable).toBe(true);
  });

  it("detects non-object content blocks", async () => {
    const contentArray = [42, "string"];
    await appendMessage(db, sessionId, makeMessage("assistant", contentArray));

    const report = await detectCorruptedSession(db, sessionId);
    expect(report.corrupted).toBe(true);
    expect(report.issues.some((i) => i.type === "invalid_content")).toBe(true);
  });

  it("detects message timestamp before session creation", async () => {
    const msgId = crypto.randomUUID();
    const oldDate = new Date("2000-01-01T00:00:00Z");
    await insertCorruptMessage(msgId, sessionId, "user", "old message", oldDate);

    const report = await detectCorruptedSession(db, sessionId);
    expect(report.corrupted).toBe(true);
    const staleIssues = report.issues.filter((i) => i.type === "stale_timestamps");
    expect(staleIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects missing role", async () => {
    const msgId = crypto.randomUUID();
    await insertCorruptMessage(msgId, sessionId, "", "no role");

    const report = await detectCorruptedSession(db, sessionId);
    expect(report.corrupted).toBe(true);
    expect(report.issues.some((i) => i.type === "missing_role")).toBe(true);
  });

  it("valid thinking blocks pass", async () => {
    const contentArray = [
      { type: "thinking", thinking: "reasoning here" },
      { type: "text", text: "response here" },
    ];
    await appendMessage(db, sessionId, makeMessage("assistant", contentArray));

    const report = await detectCorruptedSession(db, sessionId);
    expect(report.issues.filter((i) => i.type === "malformed_thinking")).toHaveLength(0);
  });

  it("plain string content passes", async () => {
    await appendMessage(db, sessionId, makeMessage("user", "just a string"));
    const report = await detectCorruptedSession(db, sessionId);
    expect(report.issues.filter((i) => i.type === "invalid_content")).toHaveLength(0);
  });

  it("reports detectedAt timestamp", async () => {
    const before = Date.now();
    const report = await detectCorruptedSession(db, sessionId);
    const after = Date.now();
    expect(report.detectedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(report.detectedAt.getTime()).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// recoverSession
// ---------------------------------------------------------------------------

describe("recoverSession", () => {
  it("returns unrecoverable for missing session", async () => {
    const fakeId = crypto.randomUUID();
    const result = await recoverSession(db, fakeId);
    expect(result.recovered).toBe(false);
    expect(result.unrecoverable.some((i) => i.type === "missing_session")).toBe(true);
  });

  it("fixes null content to empty string", async () => {
    const msgId = crypto.randomUUID();
    await insertCorruptMessage(msgId, sessionId, "user", null);

    const result = await recoverSession(db, sessionId);
    expect(result.recovered).toBe(true);
    expect(result.actions.some((a) => a.type === "empty_content")).toBe(true);

    const msgs = await getMessages(db, sessionId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("");
  });

  it("removes malformed thinking blocks (empty thinking)", async () => {
    const contentArray = [
      { type: "thinking", thinking: "" }, // empty = malformed
      { type: "text", text: "hello" },
    ];
    await appendMessage(db, sessionId, makeMessage("assistant", contentArray));

    const result = await recoverSession(db, sessionId);
    expect(result.recovered).toBe(true);
    expect(result.actions.some((a) => a.type === "malformed_thinking")).toBe(true);

    const msgs = await getMessages(db, sessionId);
    const content = JSON.parse(String(msgs[0].content ?? "[]")) as unknown[];
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: "text", text: "hello" });
  });

  it("removes thinking block with non-string thinking", async () => {
    const contentArray = [
      { type: "thinking", thinking: 42 },
      { type: "text", text: "response" },
    ];
    await appendMessage(db, sessionId, makeMessage("assistant", contentArray));

    const result = await recoverSession(db, sessionId);
    expect(result.recovered).toBe(true);

    const msgs = await getMessages(db, sessionId);
    const content = JSON.parse(String(msgs[0].content ?? "[]")) as unknown[];
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: "text", text: "response" });
  });

  it("adds missing type field to content blocks", async () => {
    const contentArray = [{ text: "hello" }]; // no type
    await appendMessage(db, sessionId, makeMessage("assistant", contentArray));

    const result = await recoverSession(db, sessionId);
    expect(result.recovered).toBe(true);

    const msgs = await getMessages(db, sessionId);
    const content = JSON.parse(String(msgs[0].content ?? "[]")) as unknown[];
    expect(content[0]).toEqual({ text: "hello", type: "text" });
  });

  it("converts non-object blocks to text blocks", async () => {
    const contentArray = [42, "string"];
    await appendMessage(db, sessionId, makeMessage("assistant", contentArray));

    const result = await recoverSession(db, sessionId);
    expect(result.recovered).toBe(true);

    const msgs = await getMessages(db, sessionId);
    const content = JSON.parse(String(msgs[0].content ?? "[]")) as unknown[];
    expect(content[0]).toEqual({ type: "text", text: "42" });
    expect(content[1]).toEqual({ type: "text", text: "string" });
  });

  it("preserves valid content during recovery", async () => {
    await appendMessage(db, sessionId, makeMessage("user", "hello"));
    await appendMessage(db, sessionId, makeMessage("assistant", "hi"));

    const result = await recoverSession(db, sessionId);
    expect(result.actions).toHaveLength(0);

    const msgs = await getMessages(db, sessionId);
    expect(msgs).toHaveLength(2);
  });

  it("fixes stale timestamps", async () => {
    const msgId = crypto.randomUUID();
    const oldDate = new Date("2000-01-01T00:00:00Z");
    await insertCorruptMessage(msgId, sessionId, "user", "old msg", oldDate);

    const result = await recoverSession(db, sessionId);
    expect(result.recovered).toBe(true);
    expect(result.actions.some((a) => a.type === "stale_timestamps")).toBe(true);
  });

  it("handles mixed corruption — null content + malformed thinking", async () => {
    const msgId = crypto.randomUUID();
    await insertCorruptMessage(msgId, sessionId, "user", null);

    await appendMessage(db, sessionId, makeMessage("assistant", [
      { type: "thinking", thinking: "" },
      { type: "text", text: "response" },
    ]));

    const result = await recoverSession(db, sessionId);
    expect(result.recovered).toBe(true);
    expect(result.actions.some((a) => a.type === "empty_content")).toBe(true);
    expect(result.actions.some((a) => a.type === "malformed_thinking")).toBe(true);

    const msgs = await getMessages(db, sessionId);
    // null content msg (fixed) + assistant msg (repaired) = 2
    expect(msgs).toHaveLength(2);
  });

  it("reports recoveredAt timestamp", async () => {
    await appendMessage(db, sessionId, makeMessage("user", "hello"));
    const before = Date.now();
    const result = await recoverSession(db, sessionId);
    const after = Date.now();
    expect(result.recoveredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.recoveredAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("updates session updatedAt after recovery", async () => {
    const msgId = crypto.randomUUID();
    await insertCorruptMessage(msgId, sessionId, "user", null);

    const before = Date.now();
    await recoverSession(db, sessionId);

    // Re-fetch session to check updatedAt was touched.
    const { getSession } = await import("./session");
    const session = await getSession(db, sessionId);
    expect(session!.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// recoverAllSessions
// ---------------------------------------------------------------------------

describe("recoverAllSessions", () => {
  it("returns empty array when no sessions are corrupted", async () => {
    await appendMessage(db, sessionId, makeMessage("user", "hello"));
    const results = await recoverAllSessions(db);
    // Our session is clean — shouldn't appear in results.
    expect(results.find((r) => r.sessionId === sessionId)).toBeUndefined();
  });

  it("recovers corrupted sessions across the database", async () => {
    const msgId = crypto.randomUUID();
    await insertCorruptMessage(msgId, sessionId, "user", null);

    const results = await recoverAllSessions(db);
    const myResult = results.find((r) => r.sessionId === sessionId);
    expect(myResult).toBeDefined();
    expect(myResult!.recovered).toBe(true);
  });
});
