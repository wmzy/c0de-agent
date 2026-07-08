// 来源：修复 bootstrapServerContext 默认 in-memory PGLite 导致进程重启丢全部数据。
// 归并建议：持久化回归专用，与 index.test.ts（导出测试）关注点不同，独立维护。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendMessage, createSession, getMessages } from '../session/index.js'
import { bootstrapServerContext, buildServerContext } from './server.js'

describe('bootstrapServerContext 数据持久化', () => {
  let tmpDir: string
  const prevEnv = process.env.C0DE_DB_DIR

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'c0de-persist-'))
    process.env.C0DE_DB_DIR = tmpDir
  })

  afterEach(async () => {
    process.env.C0DE_DB_DIR = prevEnv
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('重启（重新 bootstrap）后会话与消息持久化保留', async () => {
    // 第一次启动：写入会话 + 消息
    const first = await bootstrapServerContext()
    const session = await createSession(first.ctx.db, 'persisted')
    await appendMessage(first.ctx.db, session.id, {
      role: 'user',
      content: [{ _tag: 'text', text: 'hello-persist' }],
    })
    await first.close()

    // 第二次启动（同一 dataDir）：数据应仍在（in-memory 模式下此处必为空）
    const second = await bootstrapServerContext()
    const msgs = await getMessages(second.ctx.db, session.id)
    await second.close()

    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.content[0]).toMatchObject({ _tag: 'text', text: 'hello-persist' })
  })

  it('注入 opts.db 时跳过持久化（测试隔离路径不变）', async () => {
    const { createDB } = await import('../db/index.js')
    const injected = await createDB({ driver: 'pglite' }) // in-memory
    const { ctx, close } = await bootstrapServerContext({ db: injected })
    // 注入的 db 被直接使用，不创建持久化文件
    const session = await createSession(ctx.db, 'injected')
    expect(session.id).toBeTruthy()
    await close()
    // injected 由 close 关闭
  })
})

describe('buildServerContext 围绕复用 db 重建', () => {
  let tmpDir: string
  const prevEnv = process.env.C0DE_DB_DIR

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'c0de-rebuild-'))
    process.env.C0DE_DB_DIR = tmpDir
  })

  afterEach(async () => {
    process.env.C0DE_DB_DIR = prevEnv
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('dispose 后 db 仍可用，重建不丢 DB 数据', async () => {
    // 首次 bootstrap：写入数据
    const first = await bootstrapServerContext()
    const session = await createSession(first.ctx.db, 'rebuild-test')
    await appendMessage(first.ctx.db, session.id, {
      role: 'user',
      content: [{ _tag: 'text', text: 'before-rebuild' }],
    })
    // dispose 只清理 ctx 资源，不 close db
    await first.ctx.agentManager.dispose()
    await first.ctx.permissionStore.dispose()
    const db = first.ctx.db

    // 围绕同一 db handle 重建 ctx
    const rebuilt = await buildServerContext(db, { cwd: process.cwd(), skipHandoff: true })

    // DB 数据保留
    const msgs = await getMessages(db, session.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.content[0]).toMatchObject({ _tag: 'text', text: 'before-rebuild' })

    // 重建后 ctx 资源可用（agentManager/permissionStore 是新实例）
    expect(rebuilt.ctx.agentManager.size()).toBe(0)
    expect(rebuilt.ctx.permissionStore.size()).toBe(0)

    // 重建后仍可写入
    const session2 = await createSession(db, 'after-rebuild')
    expect(session2.id).toBeTruthy()

    await rebuilt.dispose()
    await db.close()
  })
})
