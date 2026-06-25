// In-memory session store

import type { MessageData, SessionData, SessionStore } from "./types";

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();
  private messages = new Map<string, MessageData[]>();

  private generateId(): string {
    return crypto.randomUUID();
  }

  async create(title?: string): Promise<SessionData> {
    const session: SessionData = {
      id: this.generateId(),
      title: title ?? "New Session",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    return session;
  }

  async get(id: string): Promise<SessionData | null> {
    return this.sessions.get(id) ?? null;
  }

  async list(): Promise<SessionData[]> {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
  }

  async update(id: string, data: Partial<SessionData>): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    Object.assign(session, data, { updatedAt: new Date() });
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
    this.messages.delete(id);
  }

  async addMessage(
    sessionId: string,
    message: Omit<MessageData, "id" | "sessionId" | "createdAt">,
  ): Promise<MessageData> {
    const msgs = this.messages.get(sessionId);
    if (!msgs) throw new Error(`Session not found: ${sessionId}`);

    const fullMessage: MessageData = {
      ...message,
      id: this.generateId(),
      sessionId,
      createdAt: new Date(),
    };
    msgs.push(fullMessage);

    const session = this.sessions.get(sessionId);
    if (session) session.updatedAt = new Date();

    return fullMessage;
  }

  async getMessages(sessionId: string): Promise<MessageData[]> {
    return this.messages.get(sessionId) ?? [];
  }
}

export function createMemoryStore(): SessionStore {
  return new InMemorySessionStore();
}
