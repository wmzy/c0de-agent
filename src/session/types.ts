// Session types (per design spec §8.2).
//
// Data + functions paradigm: no class, no enum. Session is the higher-level
// session object the agent loop holds (AgentState.session); SessionData is
// the DB-row representation surfaced by the session store. SessionMetadata
// is the free-form JSONB payload stored alongside a Session.

import type { ToolResult } from "../tools/types";

export type Session = {
  id: string;
  title: string;
  parentId: string | null;
  branchPoint: number | null;
  metadata: SessionMetadata;
  createdAt: number;
  updatedAt: number;
};

export type SessionMetadata = Record<string, unknown>;

export type SessionData = {
  id: string;
  projectId?: string | null;
  title: string;
  directory?: string;
  parentId?: string | null;
  branchPoint?: number | null;
  metadata?: SessionMetadata;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectData = {
  id: string;
  name: string;
  directory: string;
  description?: string;
  icon?: string;
  vcs?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type MessageData = {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolCalls?: unknown;
  toolCallId?: string;
  createdAt: Date;
};

export type SessionEntry =
  | { _tag: "message"; id: string; sessionId: string; role: "user" | "assistant" | "system"; content: string; timestamp: number }
  | { _tag: "tool_call"; id: string; sessionId: string; tool: string; input: unknown; timestamp: number }
  | { _tag: "tool_result"; id: string; sessionId: string; tool: string; output: ToolResult; timestamp: number }
  | { _tag: "compaction"; id: string; sessionId: string; summary: string; originalEntryIds: string[]; archiveId: string; tokenCount: number; timestamp: number }
  | { _tag: "squash"; id: string; sessionId: string; summary: string; squashedSessionIds: string[]; archiveId: string; tokenCount: number; timestamp: number }
  | { _tag: "branch_summary"; id: string; sessionId: string; summary: string; sourceSessionId: string; timestamp: number }
  | { _tag: "steering"; id: string; sessionId: string; content: string; timestamp: number }
  | { _tag: "file_snapshot"; id: string; sessionId: string; path: string; content: string; hash: string; tokenCount: number; timestamp: number };

export type SessionStore = {
  // Project operations
  createProject(data: Omit<ProjectData, "id" | "createdAt" | "updatedAt">): Promise<ProjectData>;
  getProject(id: string): Promise<ProjectData | null>;
  listProjects(): Promise<ProjectData[]>;
  updateProject(id: string, data: Partial<ProjectData>): Promise<void>;
  deleteProject(id: string): Promise<void>;

  // Session operations
  create(title?: string, projectId?: string): Promise<SessionData>;
  get(id: string): Promise<SessionData | null>;
  list(projectId?: string): Promise<SessionData[]>;
  update(id: string, data: Partial<SessionData>): Promise<void>;
  delete(id: string): Promise<void>;
  addMessage(
    sessionId: string,
    message: Omit<MessageData, "id" | "sessionId" | "createdAt">,
  ): Promise<MessageData>;
  getMessages(sessionId: string): Promise<MessageData[]>;
};
