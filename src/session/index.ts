// @c0de/session - Session management, branching, compaction

export const VERSION = "0.0.1";

export type { MessageData, SessionData, SessionStore } from "./types";
export { InMemorySessionStore, createMemoryStore } from "./memory";
