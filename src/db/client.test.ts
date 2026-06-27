import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { DB } from './client.js'
import { createDB } from './client.js'

describe('createDB with pglite in-memory', () => {
  it('creates an in-memory database', async () => {
    const handle = await createDB({ driver: 'pglite' })
    expect(handle.db).toBeDefined()
    expect(typeof handle.close).toBe('function')
    await handle.close()
  })

  it('can execute a simple query', async () => {
    const { db, close } = await createDB({ driver: 'pglite' })
    const result = await db.execute(sql`SELECT 1 AS value`)
    expect(result.rows[0]).toMatchObject({ value: 1 })
    await close()
  })

  it('creates separate in-memory databases (no shared state)', async () => {
    const db1 = await createDB({ driver: 'pglite' })
    const db2 = await createDB({ driver: 'pglite' })

    await db1.db.execute(sql`CREATE TABLE test_a (id int)`)
    await db2.db.execute(sql`CREATE TABLE test_b (id int)`)

    const tables1 = await db1.db.execute(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    )
    const names1 = tables1.rows.map((r: Record<string, unknown>) => r.tablename)
    expect(names1).toContain('test_a')
    expect(names1).not.toContain('test_b')

    await db1.close()
    await db2.close()
  })
})

describe('DB type', () => {
  it('has db and close properties', () => {
    const _check = (handle: DB) => {
      return { db: handle.db, close: handle.close }
    }
    expect(typeof _check).toBe('function')
  })
})
