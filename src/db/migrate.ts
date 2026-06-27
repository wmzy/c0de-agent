import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate as drizzleMigrate } from 'drizzle-orm/pglite/migrator'
import type { DB } from './client.js'

/**
 * Run all pending database migrations.
 * Migration SQL files live in `drizzle/` at the project root.
 *
 * Must be called after `createDB()` and before any queries.
 */
async function migrateDB(handle: DB): Promise<void> {
  const currentDir = fileURLToPath(new URL('.', import.meta.url))
  const migrationsFolder = resolve(currentDir, '..', '..', 'drizzle')

  await drizzleMigrate(handle.db, { migrationsFolder })
}

export { migrateDB }
