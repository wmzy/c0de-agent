import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDB } from './client.js'
import { migrateDB } from './migrate.js'

describe('migrateDB', () => {
  it('creates all tables after migration', async () => {
    const handle = await createDB({ driver: 'pglite' })
    await migrateDB(handle)

    const result = await handle.db.execute(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    )
    const tableNames = result.rows.map((r: Record<string, unknown>) => r.tablename)

    expect(tableNames).toContain('sessions')
    expect(tableNames).toContain('session_entries')
    expect(tableNames).toContain('compaction_archives')
    expect(tableNames).toContain('file_snapshots')

    await handle.close()
  })

  it('is idempotent (running twice does not error)', async () => {
    const handle = await createDB({ driver: 'pglite' })

    await migrateDB(handle)
    await expect(migrateDB(handle)).resolves.not.toThrow()

    await handle.close()
  })
})
