// Message operations — data + functions, no class

import { asc, count, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { messages, sessions } from "../db/schema";
import type { MessageData } from "./types";

export type GetMessagesOpts = {
  limit?: number;
  offset?: number;
};

export async function appendMessage(
  db: DB,
  sessionId: string,
  message: Omit<MessageData, "id" | "sessionId" | "createdAt">,
): Promise<MessageData> {
  const now = new Date();
  const [row] = await db.db
    .insert(messages)
    .values({
      id: crypto.randomUUID(),
      sessionId,
      role: message.role,
      content: (message.content as unknown as Record<string, unknown>) ?? "{}",
      tokenCount: 0,
      createdAt: now,
    })
    .returning();

  // Touch parent session timestamp
  await db.db.update(sessions).set({ updatedAt: now }).where(eq(sessions.id, sessionId));

  return row as unknown as MessageData;
}

export async function getMessages(
  db: DB,
  sessionId: string,
  opts?: GetMessagesOpts,
): Promise<MessageData[]> {
  const rows = await db.db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt))
    .limit(opts?.limit ?? 1000)
    .offset(opts?.offset ?? 0);
  return rows as unknown as MessageData[];
}

export async function getMessageCount(db: DB, sessionId: string): Promise<number> {
  const [{ count: total }] = await db.db
    .select({ count: count() })
    .from(messages)
    .where(eq(messages.sessionId, sessionId));
  return total;
}

export async function deleteMessagesAfter(
  db: DB,
  sessionId: string,
  messageIndex: number,
): Promise<void> {
  // Fetch ordered messages to resolve the index to a timestamp anchor.
  const msgs = await db.db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt));

  if (messageIndex >= msgs.length) return;

  const anchor = msgs[messageIndex];
  await db.db
    .delete(messages)
    .where(
      sql`${messages.sessionId} = ${sessionId} AND ${messages.createdAt} >= ${anchor.createdAt}`,
    );
}
