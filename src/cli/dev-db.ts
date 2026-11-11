// src/cli/dev-db.ts — CLI 全局持久库生命周期单点。
//
// 序列（mkdir dataDir → acquireDevDbLock → createDB(pglite) → migrateDB →
// 使用 → close → release）此前在 cli/index.ts 的 withAgentDeps 与
// cli/commands/config.ts 的 refreshTrustFingerprint 各持一份，锁的获取/释放
// 与清理腿极易漂移。收敛于此；错误策略显式留给调用方：
// - 锁冲突（serve 占用持久库）时提供 onLockConflict 回调决定降级（--temp
//   内存库）或抛错引导；
// - 非锁冲突错误一律如实上抛——是否吞掉（config 命令的「尽力而为、不阻塞
//   配置写入」vs withAgentDeps 的如实上抛）是调用方的有意策略，不在此收敛。

import { mkdirSync } from 'node:fs'
import type { DB } from '../db/client.js'
import { createDB, migrateDB } from '../db/index.js'
import { acquireDevDbLock, releaseDevDbLock, resolveDbDir } from '../server/server.js'

/** 判别持久库错误是否为「库被其它 c0de 进程占用」的锁冲突特征（读 server.ts 确认）：
 *  - acquireDevDbLock 对 live lock 抛出的 "Database is locked by another c0de process (PID …)"；
 *  - PGLite 单写者 WASM 崩溃 RuntimeError "Aborted()"（serve 未持锁但占用 dataDir 时的兜底特征）。
 *  其余错误（磁盘故障、迁移失败等）不属于锁冲突，不得误报 serve。 */
export function isDbLockConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.message.includes('Database is locked by another c0de process')) return true
  return err.name === 'RuntimeError' && /abort/i.test(err.message)
}

type WithPersistentDbOptions = {
  /** 锁冲突策略回调：返回替代 DB（如 --temp 内存库，调用方负责建后迁移）则
   *  以其继续执行；抛错则原样上抛（锁已释放）。未提供时锁冲突与其他错误
   *  同样如实上抛，由调用方 catch。 */
  onLockConflict?: (err: unknown, dataDir: string) => DB | Promise<DB>
}

/**
 * 打开全局持久库（PGLite dataDir）执行 fn：建目录 → 取锁 → 建库迁移 → fn →
 * 关库 → 放锁。取锁失败（mkdir/acquire 阶段）不释放；fn 与关库失败仍放锁。
 */
export async function withPersistentDb<T>(
  fn: (db: DB) => Promise<T>,
  opts: WithPersistentDbOptions = {},
): Promise<T> {
  const dataDir = resolveDbDir()
  let db: DB
  let holdLock = false
  try {
    mkdirSync(dataDir, { recursive: true })
    acquireDevDbLock(dataDir)
    holdLock = true
    db = await createDB({ driver: 'pglite', dataDir })
    await migrateDB(db)
  } catch (err) {
    if (holdLock) releaseDevDbLock(dataDir)
    holdLock = false
    if (!opts.onLockConflict || !isDbLockConflict(err)) throw err
    // 调用方策略：抛错（引导用户）或返回降级库（降级库无锁可放）
    db = await opts.onLockConflict(err, dataDir)
  }
  try {
    return await fn(db)
  } finally {
    await db.close()
    if (holdLock) releaseDevDbLock(dataDir)
  }
}
