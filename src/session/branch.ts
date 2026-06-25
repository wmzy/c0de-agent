// Session branching — data + functions, no class
//
// Fork model: forkSession creates a new session that copies every message
// up to (and including) messageIndex from the source session.  The new
// session records parentId and branchPoint so the tree can be reconstructed.

import { asc, eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { messages, sessions } from "../db/schema";
import type { SessionData } from "./types";

export async function forkSession(
  db: DB,
  sessionId: string,
  messageIndex: number,
): Promise<SessionData> {
  // Resolve source session.
  const [source] = await db.db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!source) throw new Error(`Session not found: ${sessionId}`);

  // Fetch messages to validate index and copy content.
  const msgs = await db.db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt));

  if (messageIndex < 0 || messageIndex >= msgs.length) {
    throw new Error(`Invalid message index: ${messageIndex}`);
  }

  // Create fork session row.
  const now = new Date();
  const forkId = crypto.randomUUID();
  const [fork] = await db.db
    .insert(sessions)
    .values({
      id: forkId,
      title: `${source.title} (fork)`,
      parentId: sessionId,
      branchPoint: messageIndex,
      metadata: (source as Record<string, unknown>).metadata ?? {},
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  // Clone messages up to and including branchPoint.
  const branchMsgs = msgs.slice(0, messageIndex + 1);
  for (const msg of branchMsgs) {
    await db.db.insert(messages).values({
      id: crypto.randomUUID(),
      sessionId: forkId,
      role: msg.role,
      content: msg.content ?? {},
      tokenCount: msg.tokenCount ?? 0,
      createdAt: msg.createdAt,
    });
  }

  return fork as unknown as SessionData;
}

/** Return all sessions whose parentId points to the given session. */
export async function getBranches(db: DB, sessionId: string): Promise<SessionData[]> {
  const rows = await db.db
    .select()
    .from(sessions)
    .where(eq(sessions.parentId, sessionId))
    .orderBy(asc(sessions.createdAt));
  return rows as unknown as SessionData[];
}

/** Return every session, callers assemble the tree via parentId links. */
export async function getTree(db: DB): Promise<SessionData[]> {
  const rows = await db.db.select().from(sessions).orderBy(asc(sessions.createdAt));
  return rows as unknown as SessionData[];
}
