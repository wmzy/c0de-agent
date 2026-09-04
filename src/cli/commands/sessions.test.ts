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

  it('未知子命令报错', async () => {
    await expect(
      runSessionsCommand({ args: { options: {}, positionals: ['nope'] }, db, write: () => {} }),
    ).rejects.toThrow(/unknown/i)
  })
})
