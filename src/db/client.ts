// DB client — PGLite / PostgreSQL adapter
//
// createDB(config) returns a DB handle.  The caller holds one shared instance
// for the lifetime of the application.  Data lives under ~/.c0de/data/ when
// driver is pglite.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";

export type DB = {
  driver: "pglite";
  db: ReturnType<typeof drizzle<typeof schema>>;
};

export type DBConfig = { driver: "pglite"; dataDir?: string };

export async function createDB(config: DBConfig): Promise<DB> {
  const dataDir = config.dataDir ?? `${homedir()}/.c0de/data`;
  mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);

  // Auto-create tables if they don't exist (match Drizzle schema types)
  await client.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL DEFAULT 'New Session',
      parent_id UUID,
      branch_point INTEGER,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content JSONB NOT NULL DEFAULT '[]',
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS configs (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS todos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      context TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS memories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      content TEXT NOT NULL,
      tags JSONB NOT NULL DEFAULT '[]',
      timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
      session_id UUID REFERENCES sessions(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS squash_archives (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      summary_message_id UUID,
      summary TEXT NOT NULL,
      original_messages JSONB NOT NULL,
      message_ids JSONB NOT NULL,
      message_count INTEGER NOT NULL,
      estimated_tokens_saved INTEGER NOT NULL DEFAULT 0,
      hot_files JSONB DEFAULT '[]',
      rollback_applied JSONB NOT NULL DEFAULT 'false',
      rollback_timestamp TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  const db = drizzle(client, { schema });
  return { driver: "pglite", db };
}

export async function migrateDB(db: DB): Promise<void> {
  await migrate(db.db, { migrationsFolder: "./drizzle" });
}
