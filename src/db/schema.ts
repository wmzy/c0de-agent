import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Projects table — git repos or plain directories tracked for agent workspaces.
 * Identity: sha256(worktree)[:16]（git 仓库用仓库根，普通目录用绝对路径）。gitRemote 仅作
 * 元数据，不参与 id——避免「先无 remote 注册、后加 remote」导致 id 漂移。
 */
export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  worktree: text('worktree').notNull(),
  vcs: text('vcs'),
  name: text('name'),
  gitRemote: text('git_remote'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Sessions table — conversation sessions with branching support.
 * Root sessions have parentId = null. Forked sessions reference their parent.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => sessions.id),
    projectId: text('project_id').references((): AnyPgColumn => projects.id, {
      onDelete: 'set null',
    }),
    branchPoint: integer('branch_point'),
    metadata: jsonb('metadata').notNull().default({}),
    agentType: text('agent_type'),
    worktreePath: text('worktree_path'),
    /** 会话来源：'web'（Web UI）/ 'cli'（CLI print 模式）；null=旧数据视为 web。 */
    source: text('source').default(sql`null`),
    /** 软删除时间戳；null=未删除。回收站保留 30 天后物理清除。 */
    deletedAt: timestamp('deleted_at', { withTimezone: true }).default(sql`null`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_sessions_parent').on(table.parentId),
    index('idx_sessions_project').on(table.projectId),
  ],
)

/**
 * Session entries table — unified storage for all session content types.
 * The `tag` field discriminates: 'message' | 'tool_call' | 'tool_result' |
 * 'compaction' | 'squash' | 'branch_summary' | 'steering' | 'file_snapshot'.
 */
export const sessionEntries = pgTable(
  'session_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
    role: text('role'),
    content: jsonb('content').notNull(),
    toolName: text('tool_name'),
    tokenCount: integer('token_count').default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_entries_session').on(table.sessionId, table.createdAt)],
)

/**
 * Compaction archives — stores original entries that were compacted/squashed.
 * Searchable via full-text search on `searchableText`.
 */
export const compactionArchives = pgTable(
  'compaction_archives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    compactionId: uuid('compaction_id').notNull(),
    archiveType: text('archive_type').notNull(),
    originalEntries: jsonb('original_entries').notNull(),
    fileSnapshots: jsonb('file_snapshots').default([]),
    summary: text('summary').notNull(),
    tokenCount: integer('token_count'),
    searchableText: text('searchable_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_archives_session').on(table.sessionId),
    // Full-text search index (GIN) for archive content search
    sql`CREATE INDEX IF NOT EXISTS "idx_archives_search" ON "compaction_archives" USING gin(to_tsvector('english', coalesce(${table.searchableText}, '')))`,
  ],
)

/**
 * File snapshots — caches hot file content to avoid repeated read tool calls.
 * Versioned per (session_id, file_path).
 */
export const fileSnapshots = pgTable(
  'file_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id'),
    filePath: text('file_path').notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    tokenCount: integer('token_count').default(0),
    version: integer('version').default(1),
    /** 快照创建时文件磁盘 mtime（毫秒）。注入前比对，过期自动重读（P1-5）。 */
    mtimeMs: bigint('mtime_ms', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_snapshots_session_path').on(table.sessionId, table.filePath),
    uniqueIndex('idx_snapshots_latest').on(table.sessionId, table.filePath, table.version),
  ],
)

/**
 * Tool metrics table — per-(model, tool, mode) success/latency stats used to
 * auto-select the best tool mode (spec §16.5). One row per unique combination.
 */
export const toolMetrics = pgTable(
  'tool_metrics',
  {
    model: text('model').notNull(),
    tool: text('tool').notNull(),
    mode: text('mode').notNull(),
    attempts: integer('attempts').notNull().default(0),
    successes: integer('successes').notNull().default(0),
    failures: integer('failures').notNull().default(0),
    avgLatencyMs: real('avg_latency_ms').notNull().default(0),
    lastUsed: timestamp('last_used', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_tool_metrics_model_tool_mode').on(table.model, table.tool, table.mode),
  ],
)

/**
 * Kanban boards — one per project (unique projectId). Stores column/label
 * configuration as JSON; cards live in kanban_cards.
 */
export const kanbanBoards = pgTable(
  'kanban_boards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Column definitions: [{ id, name }] */
    columns: jsonb('columns').notNull(),
    /** Label definitions: [{ id, name, color }] */
    labels: jsonb('labels').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('uq_kanban_boards_project').on(table.projectId)],
)

/**
 * Kanban cards — tasks on a board. position is a real for fractional indexing
 * (insert between two cards without rewriting all positions). columnId
 * references a column id in the parent board's columns JSON.
 */
export const kanbanCards = pgTable(
  'kanban_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => kanbanBoards.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    columnId: text('column_id').notNull(),
    priority: text('priority').notNull().default('medium'),
    position: real('position').notNull().default(0),
    /** Label ids referencing board.labels[].id */
    labels: jsonb('labels').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_kanban_cards_board').on(table.boardId, table.columnId, table.position)],
)

/** Type exports for insert/select operations. */
export type ProjectRow = typeof projects.$inferSelect
export type ProjectInsert = typeof projects.$inferInsert
export type SessionRow = typeof sessions.$inferSelect
export type SessionInsert = typeof sessions.$inferInsert
export type SessionEntryRow = typeof sessionEntries.$inferSelect
export type SessionEntryInsert = typeof sessionEntries.$inferInsert
export type CompactionArchiveRow = typeof compactionArchives.$inferSelect
export type CompactionArchiveInsert = typeof compactionArchives.$inferInsert
export type FileSnapshotRow = typeof fileSnapshots.$inferSelect
export type FileSnapshotInsert = typeof fileSnapshots.$inferInsert
export type ToolMetricRow = typeof toolMetrics.$inferSelect
export type ToolMetricInsert = typeof toolMetrics.$inferInsert
export type KanbanBoardRow = typeof kanbanBoards.$inferSelect
export type KanbanBoardInsert = typeof kanbanBoards.$inferInsert
export type KanbanCardRow = typeof kanbanCards.$inferSelect
export type KanbanCardInsert = typeof kanbanCards.$inferInsert
