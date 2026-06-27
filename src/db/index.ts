// DB package: Drizzle schema, PGLite/PostgreSQL client, migrations.

export type { DB } from './client.js'
export { createDB } from './client.js'
export { migrateDB } from './migrate.js'
export type {
  CompactionArchiveInsert,
  CompactionArchiveRow,
  FileSnapshotInsert,
  FileSnapshotRow,
  SessionEntryInsert,
  SessionEntryRow,
  SessionInsert,
  SessionRow,
} from './schema.js'
export {
  compactionArchives,
  fileSnapshots,
  sessionEntries,
  sessions,
} from './schema.js'
export type { DBConfig, DBDriver } from './types.js'
