// c0de trust 命令测试：信任前展示风险清单、有风险必须 --yes（P1 CLI 盲信任修复）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { getByDirectory } from '../../project/project.js'
import { runTrustCommand } from './trust.js'

let dir: string
let projDir: string
let db: DB

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'c0de-trustcmd-'))
  projDir = join(dir, 'proj')
  mkdirSync(join(projDir, '.c0de'), { recursive: true })
  db = await createDB({ driver: 'pglite', dataDir: join(dir, 'data') })
  await migrateDB(db)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

function seedProjectConfig(content: Record<string, unknown>): void {
  writeFileSync(join(projDir, '.c0de', 'config.json'), JSON.stringify(content), 'utf-8')
}

describe('c0de trust', () => {
  it('项目含风险配置且无 --yes → 拒绝并列出风险项与确认指引', async () => {
    seedProjectConfig({ permission: { defaultMode: 'auto' } })
    const out: string[] = []
    const err = await runTrustCommand({
      args: { options: {}, positionals: [projDir] },
      db,
      cwd: dir,
      write: (s) => out.push(s),
    }).catch((e: unknown) => (e instanceof Error ? e.message : String(e)))
    expect(err).toContain('--yes')
    expect(err).toContain('permission-auto')
    expect(err).toContain('权限模式 auto')
  })

  it('项目含风险配置 + --yes → 落盘信任（trustedAt 非空）', async () => {
    seedProjectConfig({ permission: { defaultMode: 'auto' } })
    const out: string[] = []
    await runTrustCommand({
      args: { options: { yes: true }, positionals: [projDir] },
      db,
      cwd: dir,
      write: (s) => out.push(s),
    })
    expect(out.join('')).toContain('已信任项目')
    const project = await getByDirectory(db, projDir)
    expect(project?.trustedAt).not.toBeNull()
    expect(project?.riskFingerprint).not.toBe('')
  })

  it('无项目风险 + --yes → 信任成功（无论本机全局配置是否含风险）', async () => {
    seedProjectConfig({ theme: 'dark' })
    const out: string[] = []
    await runTrustCommand({
      args: { options: { yes: true }, positionals: [projDir] },
      db,
      cwd: dir,
      write: (s) => out.push(s),
    })
    expect(out.join('')).toContain('已信任项目')
  })
})
