// In-memory session store

import type { MessageData, ProjectData, SessionData, SessionStore } from "./types";

export class InMemorySessionStore implements SessionStore {
  private projects = new Map<string, ProjectData>();
  private sessions = new Map<string, SessionData>();
  private messages = new Map<string, MessageData[]>();

  private generateId(): string {
    return crypto.randomUUID();
  }

  // ── Project operations ──────────────────────────────────────────────────

  async createProject(
    data: Omit<ProjectData, "id" | "createdAt" | "updatedAt">,
  ): Promise<ProjectData> {
    const project: ProjectData = {
      ...data,
      id: this.generateId(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.projects.set(project.id, project);
    return project;
  }

  async getProject(id: string): Promise<ProjectData | null> {
    return this.projects.get(id) ?? null;
  }

  async listProjects(): Promise<ProjectData[]> {
    return Array.from(this.projects.values()).sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
  }

  async updateProject(id: string, data: Partial<ProjectData>): Promise<void> {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    Object.assign(project, data, { updatedAt: new Date() });
  }

  async deleteProject(id: string): Promise<void> {
    this.projects.delete(id);
    // Unlink sessions from this project
    for (const session of this.sessions.values()) {
      if (session.projectId === id) {
        session.projectId = null;
      }
    }
  }

  // ── Session operations ──────────────────────────────────────────────────

  async create(title?: string, projectId?: string): Promise<SessionData> {
    const session: SessionData = {
      id: this.generateId(),
      projectId: projectId ?? null,
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

  async list(projectId?: string): Promise<SessionData[]> {
    let sessions = Array.from(this.sessions.values());
    if (projectId) {
      sessions = sessions.filter((s) => s.projectId === projectId);
    }
    return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
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
