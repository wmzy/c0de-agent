/**
 * fromDirectory 单测。归属：项目注册/去重逻辑（project.ts）。
 * 与 resolve.test.ts / detect.test.ts 并列，覆盖 worktree 维度的幂等与漂移合并。
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { projects, sessions } from '../db/schema.js'
import type { Config } from '../shared/types/config.js'
import { enforceProjectTrust, fromDirectory, listProjects, trustProject } from './project.js'
import { resolveProject } from './resolve.js'

let dbHandle: DB | undefined
afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
})

async function setup() {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  return db
}

describe('fromDirectory', () => {
  it('同目录连续调用幂等，不产生重复项目', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fromdir-idem-'))
    try {
      const db = await setup()
      const a = await fromDirectory(db, dir)
      const b = await fromDirectory(db, dir)
      expect(a.id).toBe(b.id)
      const sameWorktree = (await listProjects(db)).filter((p) => p.worktree === dir)
      expect(sameWorktree).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('合并同 worktree 的漂移孤儿项目：迁移其会话并删除孤儿', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fromdir-merge-'))
    try {
      const db = await setup()
      const canonical = resolveProject(dir).id
      const driftProjectId = 'driftdead000000'
      const sessionId = randomUUID()
      // 造历史漂移产物：同 worktree 但 id 不同（旧实现按 remote 生成 id 时遗留），
      // 并在其名下挂一个会话。
      await db.db.insert(projects).values({ id: driftProjectId, worktree: dir, name: 'dup' })
      await db.db
        .insert(sessions)
        .values({ id: sessionId, title: 'Orphan', projectId: driftProjectId })

      const result = await fromDirectory(db, dir)
      expect(result.id).toBe(canonical)

      const all = await listProjects(db)
      expect(all.find((p) => p.id === driftProjectId)).toBeUndefined()
      expect(all.filter((p) => p.worktree === dir)).toHaveLength(1)

      const moved = await db.db.select().from(sessions).where(eq(sessions.id, sessionId))
      expect(moved).toHaveLength(1)
      expect(moved[0]?.projectId).toBe(canonical)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('enforceProjectTrust（CLI 项目信任门禁）', () => {
  /** 建含 .c0de/config.json 的临时目录 + 注册项目记录（默认不信任）。 */
  async function setupProject(
    db: DB,
    config: Record<string, unknown>,
  ): Promise<{ dir: string; projectId: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-trustgate-'))
    await mkdir(join(dir, '.c0de'), { recursive: true })
    await writeFile(join(dir, '.c0de', 'config.json'), JSON.stringify(config), 'utf-8')
    const project = await fromDirectory(db, dir)
    return { dir, projectId: project.id }
  }

  it('未信任项目 + 风险配置 → 抛错（要求 c0de trust）', async () => {
    const db = await setup()
    const { dir } = await setupProject(db, { permission: { defaultMode: 'auto' } })
    try {
      await expect(enforceProjectTrust(db, dir, {})).rejects.toThrow(/c0de trust/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未信任项目 + 无风险配置 → 放行', async () => {
    const db = await setup()
    const { dir } = await setupProject(db, { permission: { defaultMode: 'default' } })
    try {
      await expect(enforceProjectTrust(db, dir, {})).resolves.toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未信任项目 + 全局 auto（项目无风险）→ 抛错（全局权限风险兜底）', async () => {
    const db = await setup()
    const { dir } = await setupProject(db, { permission: { defaultMode: 'default' } })
    try {
      await expect(
        enforceProjectTrust(db, dir, { permission: { defaultMode: 'auto' } } as Partial<Config>),
      ).rejects.toThrow(/c0de trust/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('信任后（指纹落盘）→ 放行', async () => {
    const db = await setup()
    const { dir, projectId } = await setupProject(db, { permission: { defaultMode: 'auto' } })
    try {
      await trustProject(db, projectId)
      await expect(enforceProjectTrust(db, dir, {})).resolves.toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('信任后配置漂移（新增风险键）→ 重新抛错要求复验', async () => {
    const db = await setup()
    const { dir, projectId } = await setupProject(db, { permission: { defaultMode: 'auto' } })
    try {
      await trustProject(db, projectId)
      // 模拟仓库 git pull 后新增插件风险键：指纹漂移 → 门禁复发
      await writeFile(
        join(dir, '.c0de', 'config.json'),
        JSON.stringify({ permission: { defaultMode: 'auto' }, plugins: { enabled: ['evil'] } }),
        'utf-8',
      )
      await expect(enforceProjectTrust(db, dir, {})).rejects.toThrow(/c0de trust/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
