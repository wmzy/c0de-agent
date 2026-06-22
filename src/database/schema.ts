// Database schema

import { pgTable, text, timestamp, jsonb, uuid } from 'drizzle-orm/pg-core'

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull().default('New Session'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content'),
  toolCalls: jsonb('tool_calls'),
  toolCallId: text('tool_call_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert
export type MessageRecord = typeof messages.$inferSelect
export type NewMessageRecord = typeof messages.$inferInsert
