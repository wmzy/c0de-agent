import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import type { PgliteDatabase } from 'drizzle-orm/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { Pool } from 'pg'
import * as schema from './schema.js'
import type { DBConfig } from './types.js'

/**
 * Unified database handle.
 * `db` is the Drizzle ORM instance with schema bound.
 * `close()` cleans up the connection.
 * `sync()` (PGLite only) flushes WAL to filesystem — periodic call 缩短
 * 突然停机（kill -9）时的数据丢失窗口，是 WAL 之外的额外保险。
 */
type DB = {
  db: PgliteDatabase<typeof schema>
  close(): Promise<void>
  /** PGLite：syncToFs(false) 全量刷盘；PostgreSQL 模式下为 no-op（服务端自行管理）。 */
  sync?(): Promise<void>
}

/**
 * Create a database connection.
 *
 * - PGLite mode: in-process WASM Postgres, no server needed.
 *   Pass `dataDir` for persistent storage, omit for in-memory (tests).
 * - PostgreSQL mode: connects to a real PG server via connection string.
 */
async function createDB(config: DBConfig): Promise<DB> {
  if (config.driver === 'pglite') {
    const connection =
      config.dataDir && config.dataDir !== ':memory:' ? { dataDir: config.dataDir } : undefined
    const db = drizzle({ schema, connection })
    // $client is the underlying PGlite (WASM Postgres) instance drizzle created
    // from the connection option. Without closing it, each instance leaks
    // ~100MB+ of WASM memory — which OOM-kills vitest worker forks when many
    // test files run in the same process.
    const client = db.$client
    return {
      db,
      async close() {
        await client.close()
      },
      async sync() {
        // P2-15：主动把 WAL 刷到文件系统（默认非 relaxedDurability 全量 fsync），
        // 使 kill -9 等非优雅退出时已提交事务不丢。失败吞掉（尽力而为）。
        await client.syncToFs().catch(() => {})
      },
    }
  }

  // PostgreSQL mode — cast to PgliteDatabase for a unified interface.
  // The underlying Drizzle ORM query API is identical across drivers.
  const pool = new Pool({ connectionString: config.connectionString })
  const db = drizzlePg(pool, { schema }) as unknown as PgliteDatabase<typeof schema>
  return {
    db,
    async close() {
      await pool.end()
    },
  }
}

export type { DB }
export { createDB }
