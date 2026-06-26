// Session CRUD — data + functions, no class
//
// Each function takes a DB handle as its first parameter so callers can share
// one connection across the whole application.

import { desc, eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { sessions } from "../db/schema";
import type { SessionData } from "./types";

export async function createSession(db: DB, title?: string, projectId?: string): Promise<SessionData> {
  const now = new Date();
  const [row] = await db.db
    .insert(sessions)
    .values({
      id: crypto.randomUUID(),
      title: title ?? "New Session",
      projectId: projectId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row as unknown as SessionData;
}

export async function getSession(db: DB, id: string): Promise<SessionData | null> {
  const [row] = await db.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  return (row as unknown as SessionData) ?? null;
}

export async function listSessions(db: DB, projectId?: string): Promise<SessionData[]> {
  let query = db.db.select().from(sessions);
  if (projectId) {
    query = query.where(eq(sessions.projectId, projectId));
  }
  const rows = await query.orderBy(desc(sessions.updatedAt));
  return rows as unknown as SessionData[];
}

export async function deleteSession(db: DB, id: string): Promise<void> {
  await db.db.delete(sessions).where(eq(sessions.id, id));
}

export async function updateSessionTitle(db: DB, id: string, title: string): Promise<void> {
  await db.db.update(sessions).set({ title, updatedAt: new Date() }).where(eq(sessions.id, id));
}
