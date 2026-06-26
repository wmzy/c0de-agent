// Drizzle ORM schema — data + functions, no class
//
// Three tables: sessions, messages (FK → sessions), and configs (KV store).

import { integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

// ── projects ─────────────────────────────────────────────────────────────────

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  directory: text("directory").notNull(),
  description: text("description"),
  metadata: jsonb("metadata").notNull().default("{}"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── sessions ────────────────────────────────────────────────────────────────

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull().default("New Session"),
  parentId: uuid("parent_id"),
  branchPoint: integer("branch_point"),
  metadata: jsonb("metadata").notNull().default("{}"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── messages ────────────────────────────────────────────────────────────────

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: jsonb("content").notNull(),
  tokenCount: integer("token_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── configs ─────────────────────────────────────────────────────────────────

export const configs = pgTable("configs", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

// ── squash_archives ────────────────────────────────────────────────────────

export const squashArchives = pgTable("squash_archives", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  summaryMessageId: uuid("summary_message_id"),
  summary: text("summary").notNull(),
  originalMessages: jsonb("original_messages").notNull(),
  /** Array of message UUIDs that were squashed. */
  messageIds: jsonb("message_ids").notNull(),
  messageCount: integer("message_count").notNull(),
  estimatedTokensSaved: integer("estimated_tokens_saved").notNull().default(0),
  hotFiles: jsonb("hot_files").default("[]"),
  rollbackApplied: jsonb("rollback_applied").notNull().default("false"),
  rollbackTimestamp: timestamp("rollback_timestamp"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── compaction_archives ─────────────────────────────────────────────────────



export const compactionArchives = pgTable("compaction_archives", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  compactionId: uuid("compaction_id").notNull(),
  archiveType: text("archive_type").notNull(),
  originalEntries: jsonb("original_entries").notNull(),
  fileSnapshots: jsonb("file_snapshots").default("[]"),
  summary: text("summary").notNull(),
  tokenCount: integer("token_count"),
  searchableText: text("searchable_text"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── file_snapshots ───────────────────────────────────────────────────────────

export const fileSnapshots = pgTable("file_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  entryId: uuid("entry_id"),
  filePath: text("file_path").notNull(),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),
  tokenCount: integer("token_count").default(0),
  version: integer("version").default(1),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── todo_status ────────────────────────────────────────────────────────────

export const todos = pgTable("todos", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  status: text("status").notNull().default("pending"),
  priority: text("priority").notNull().default("medium"),
  context: text("context"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TodoRow = typeof todos.$inferSelect;
export type NewTodoRow = typeof todos.$inferInsert;

// ── memories (MnemoPi) ─────────────────────────────────────────────────────

export const memories = pgTable("memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  content: text("content").notNull(),
  tags: jsonb("tags").notNull().default("[]"),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
  sessionId: uuid("session_id").references(() => sessions.id, {
    onDelete: "set null",
  }),
  importance: real("importance").notNull().default(1.0),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessed: timestamp("last_accessed"),
});

// ── memory_associations (MnemoPi) ────────────────────────────────────────

export const memoryAssociations = pgTable("memory_associations", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => memories.id, { onDelete: "cascade" }),
  targetId: uuid("target_id")
    .notNull()
    .references(() => memories.id, { onDelete: "cascade" }),
  relation: text("relation").notNull().default("similar"),
  strength: real("strength").notNull().default(1.0),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Inferred types ──────────────────────────────────────────────────────────

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type ConfigRow = typeof configs.$inferSelect;
export type NewConfigRow = typeof configs.$inferInsert;
export type SquashArchiveRow = typeof squashArchives.$inferSelect;
export type NewSquashArchiveRow = typeof squashArchives.$inferInsert;
export type CompactionArchiveRow = typeof compactionArchives.$inferSelect;
export type NewCompactionArchiveRow = typeof compactionArchives.$inferInsert;
export type FileSnapshotRow = typeof fileSnapshots.$inferSelect;
export type NewFileSnapshotRow = typeof fileSnapshots.$inferInsert;
export type MemoryRow = typeof memories.$inferSelect;
export type NewMemoryRow = typeof memories.$inferInsert;
export type MemoryAssociationRow = typeof memoryAssociations.$inferSelect;
export type NewMemoryAssociationRow = typeof memoryAssociations.$inferInsert;
