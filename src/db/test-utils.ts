import { sql } from 'drizzle-orm'
import type { DB } from './client.js'
import { createDB } from './client.js'
import { migrateDB } from './migrate.js'

/**
 * 创建已迁移的测试用 PGlite 实例。
 *
 * 性能背景：每个 PGlite 实例首次查询时需初始化 WASM Postgres，
 * 实测 ~1.1s/实例。测试若每用例新建实例（旧 setup 模式），
 * 90% 的时间花在重复初始化上。正确用法：
 *
 *   let db: DB
 *   beforeAll(async () => { db = await createTestDB() })
 *   afterAll(async () => { await db.close() })
 *   afterEach(async () => { await resetTestDB(db) })
 *
 * 用例间用 TRUNCATE 重置（实测 ~9ms），获得与「每用例新实例」
 * 等价的隔离性，但每个文件只付一次初始化成本。
 */
export async function createTestDB(): Promise<DB> {
  const db = await createDB({ driver: 'pglite' })
  await migrateDB(db)
  return db
}

/**
 * 清空测试 DB 的全部用户表（TRUNCATE ... CASCADE）。
 *
 * 表名从 information_schema 动态枚举——新增迁移表时无需改这里。
 * CASCADE 覆盖外键引用；序列不重置（主键为 uuid/自增递增均安全）。
 */
export async function resetTestDB(db: DB): Promise<void> {
  const tables = await db.db.execute(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  )
  const names = tables.rows
    .map((row) => {
      const name = Object.values(row)[0]
      return typeof name === 'string' ? `"${name}"` : null
    })
    .filter((n): n is string => n !== null)
  if (names.length === 0) return
  await db.db.execute(sql.raw(`TRUNCATE ${names.join(', ')} CASCADE`))
}
