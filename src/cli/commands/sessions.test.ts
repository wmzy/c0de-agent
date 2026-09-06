// c0de sessions 命令测试：列出/删除会话（P3：清理 CLI 会话积累）。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createSession, listAllSessions, listDeletedSessions } from '../../session/session.js'
import { runSessionsCommand } from './sessions.js'

let dir: string
let db: DB

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'c0de-sesscmd-'))
  db = await createDB({ driver: 'pglite', dataDir: dir })
  await migrateDB(db)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('c0de sessions', () => {
  it('list 输出会话并按来源标注', async () => {
    await createSession(db, 'web-session', undefined, undefined, 'web')
    await createSession(db, 'cli-session', undefined, undefined, 'cli')
    const out: string[] = []
    await runSessionsCommand({
      args: { options: {}, positionals: ['list'] },
      db,
      write: (s) => out.push(s),
    })
    const text = out.join('')
    expect(text).toContain('[web] web-session')
    expect(text).toContain('[cli] cli-session')
  })

  it('list 无会话时提示', async () => {
    const out: string[] = []
    await runSessionsCommand({
      args: { options: {}, positionals: [] },
      db,
      write: (s) => out.push(s),
    })
    expect(out.join('')).toContain('无会话')
  })

  it('delete 软删除指定会话（进回收站）', async () => {
    const s = await createSession(db, 'to-delete', undefined, undefined, 'cli')
    const out: string[] = []
    await runSessionsCommand({
      args: { options: {}, positionals: ['delete', s.id] },
      db,
      write: (s) => out.push(s),
    })
    expect(await listAllSessions(db)).toHaveLength(0)
    expect(await listDeletedSessions(db)).toHaveLength(1)
    expect(out.join('')).toContain('回收站')
  })

  it('delete 缺 id 报错', async () => {
    await expect(
      runSessionsCommand({ args: { options: {}, positionals: ['delete'] }, db, write: () => {} }),
    ).rejects.toThrow(/id/i)
  })

  it('delete 不存在的会话报错', async () => {
    await expect(
      runSessionsCommand({
        args: { options: {}, positionals: ['delete', '00000000-0000-0000-0000-000000000000'] },
        db,
        write: () => {},
      }),
    ).rejects.toThrow(/not found/i)
  })

  it('restore 恢复已软删除会话（delete → restore 闭环）', async () => {
    const s = await createSession(db, 'to-restore', undefined, undefined, 'cli')
    await runSessionsCommand({
      args: { options: {}, positionals: ['delete', s.id] },
      db,
      write: () => {},
    })
    expect(await listDeletedSessions(db)).toHaveLength(1)
    const out: string[] = []
    await runSessionsCommand({
      args: { options: {}, positionals: ['restore', s.id] },
      db,
      write: (x) => out.push(x),
    })
    expect(out.join('')).toContain('已恢复')
    expect(await listAllSessions(db)).toHaveLength(1)
    expect(await listDeletedSessions(db)).toHaveLength(0)
  })

  it('restore 未删除/不存在会话报错', async () => {
    const s = await createSession(db, 'alive', undefined, undefined, 'cli')
    await expect(
      runSessionsCommand({
        args: { options: {}, positionals: ['restore', s.id] },
        db,
        write: () => {},
      }),
    ).rejects.toThrow(/not found|not deleted/i)
  })

  it('restore --project 把孤儿会话归属到指定项目（P2 CLI rebind 出口）', async () => {
    // 无归属的已删会话（模拟项目被删除后的孤儿）
    const s = await createSession(db, 'orphan', undefined, undefined, 'web')
    await runSessionsCommand({
      args: { options: {}, positionals: ['delete', s.id] },
      db,
      write: () => {},
    })
    // 目标项目目录
    const projDir = mkdtempSync(join(tmpdir(), 'c0de-sessproj-'))
    try {
      const out: string[] = []
      await runSessionsCommand({
        args: { options: { project: projDir }, positionals: ['restore', s.id] },
        db,
        write: (x) => out.push(x),
      })
      expect(out.join('')).toContain('已重新归属到项目')
      const { getSession } = await import('../../session/session.js')
      const restored = await getSession(db, s.id)
      expect(restored?.projectId).toBeTruthy()
      expect(restored?.worktreePath).toBe(projDir)
    } finally {
      rmSync(projDir, { recursive: true, force: true })
    }
  })

  it('restore --project 目录不存在时报错提示', async () => {
    const s = await createSession(db, 'orphan2', undefined, undefined, 'web')
    await runSessionsCommand({
      args: { options: {}, positionals: ['delete', s.id] },
      db,
      write: () => {},
    })
    const out: string[] = []
    await runSessionsCommand({
      args: { options: { project: '/no/such/dir-xyz' }, positionals: ['restore', s.id] },
      db,
      write: (x) => out.push(x),
    })
    expect(out.join('')).toContain('项目归属失败')
  })

  it('deleted 列出回收站会话', async () => {
    const s = await createSession(db, 'in-trash', undefined, undefined, 'cli')
    await runSessionsCommand({
      args: { options: {}, positionals: ['delete', s.id] },
      db,
      write: () => {},
    })
    const out: string[] = []
    await runSessionsCommand({
      args: { options: {}, positionals: ['deleted'] },
      db,
      write: (x) => out.push(x),
    })
    expect(out.join('')).toContain('in-trash')
  })

  it('未知子命令报错', async () => {
    await expect(
      runSessionsCommand({ args: { options: {}, positionals: ['nope'] }, db, write: () => {} }),
    ).rejects.toThrow(/unknown/i)
  })
})
