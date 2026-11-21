// manager 生命周期测试：同 key 复用、跨 workspaceRoot 隔离、idle 回收、
// 死亡重启（至多一次）、disposeAll。用假服务器 fixture（node 脚本）真实 spawn。

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { createLspManager } from './manager.js'
import type { LspServerDef } from './types.js'

const fixtureDir = dirname(fileURLToPath(import.meta.url))
const fakeServer = join(fixtureDir, 'fixtures', 'fake-server.mjs')
const workRoot = await mkdtemp(join(tmpdir(), 'lsp-manager-'))

/** 假服务器 def：command=process.execPath、args=[fixture]，绕过 PATH 查找。 */
function fakeDef(): LspServerDef {
  return {
    name: 'fake-lsp',
    command: process.execPath,
    args: [fakeServer],
    fileTypes: ['ts'],
    rootMarkers: [],
  }
}

async function newRoot(): Promise<string> {
  return mkdtemp(join(workRoot, 'ws-'))
}

/** 等 client 进入 dead 状态（进程退出是异步到达的）。 */
async function waitDead(client: { isDead: () => boolean }, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!client.isDead()) {
    if (Date.now() > deadline) throw new Error('client did not die in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

describe('createLspManager', () => {
  it('reuses the same client for the same (name, workspaceRoot)', async () => {
    const manager = createLspManager()
    const root = await newRoot()
    const a = await manager.acquire(fakeDef(), root)
    const b = await manager.acquire(fakeDef(), root)
    expect(b).toBe(a)
    await manager.disposeAll()
    expect(a.isDead()).toBe(true)
  })

  it('creates separate clients per workspaceRoot', async () => {
    const manager = createLspManager()
    const a = await manager.acquire(fakeDef(), await newRoot())
    const b = await manager.acquire(fakeDef(), await newRoot())
    expect(b).not.toBe(a)
    await manager.disposeAll()
  })

  it('restarts a dead client once, then reports repeated exits', async () => {
    const manager = createLspManager()
    const root = await newRoot()
    const first = await manager.acquire(fakeDef(), root)
    first.notify('test/exit')
    await waitDead(first)
    const second = await manager.acquire(fakeDef(), root)
    expect(second).not.toBe(first)
    second.notify('test/exit')
    await waitDead(second)
    await expect(manager.acquire(fakeDef(), root)).rejects.toThrow(/keeps exiting/)
    await manager.disposeAll()
  })

  it('disposes idle clients after the idle window', async () => {
    const manager = createLspManager({ idleMs: 150 })
    const root = await newRoot()
    const client = await manager.acquire(fakeDef(), root)
    await new Promise((r) => setTimeout(r, 500))
    expect(client.isDead()).toBe(true)
    // idle 回收后同一 key 再 acquire 得到新实例。
    const revived = await manager.acquire(fakeDef(), root)
    expect(revived).not.toBe(client)
    await manager.disposeAll()
  })
})
