// @c0de/session - Type definitions

export interface SessionData {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageData {
  id: string;
  sessionId: string;
  role: string;
  content: string | null;
  toolCalls?: unknown;
  toolCallId?: string;
  createdAt: Date;
}

export interface SessionStore {
  create(title?: string): Promise<SessionData>;
  get(id: string): Promise<SessionData | null>;
  list(): Promise<SessionData[]>;
  update(id: string, data: Partial<SessionData>): Promise<void>;
  delete(id: string): Promise<void>;

  addMessage(
    sessionId: string,
    message: Omit<MessageData, "id" | "sessionId" | "createdAt">,
  ): Promise<MessageData>;
  getMessages(sessionId: string): Promise<MessageData[]>;
}
