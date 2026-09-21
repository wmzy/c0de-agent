import { getEventListeners } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cleanupSnapshot, performHotUpdate, waitForProgramChange } from './updater.js'

const snapshot = { version: '0.1.0', sessions: [], entries: [], config: null, timestamp: 1 }

function tmpPath(): string {
  return join(tmpdir(), `upd-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

describe('performHotUpdate', () => {
  it('serializes snapshot, installs, then spawns (in order)', async () => {
    const calls: string[] = []
    const installFn = vi.fn(async () => {
      calls.push('install')
    })
    const spawnFn = vi.fn(async () => {
      calls.push('spawn')
    })
    const path = tmpPath()
    const r = await performHotUpdate(snapshot, {
      installFn,
      spawnNewInstanceFn: spawnFn,
      snapshotPath: path,
    })
    expect(r._tag).toBe('success')
    expect(calls).toEqual(['install', 'spawn'])
    expect(installFn).toHaveBeenCalledWith('c0de-agent', expect.anything())
    const written = JSON.parse(await readFile(path, 'utf8')) as { version: string }
    expect(written.version).toBe('0.1.0')
  })

  it('returns install_failed when install throws', async () => {
    const installFn = vi.fn().mockRejectedValue(new Error('network down'))
    const spawnFn = vi.fn().mockResolvedValue(undefined)
    const r = await performHotUpdate(snapshot, {
      installFn,
      spawnNewInstanceFn: spawnFn,
      snapshotPath: tmpPath(),
    })
    expect(r._tag).toBe('install_failed')
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('returns spawn_failed when spawn throws', async () => {
    const installFn = vi.fn().mockResolvedValue(undefined)
    const spawnFn = vi.fn().mockRejectedValue(new Error('no binary'))
    const r = await performHotUpdate(snapshot, {
      installFn,
      spawnNewInstanceFn: spawnFn,
      snapshotPath: tmpPath(),
    })
    expect(r._tag).toBe('spawn_failed')
    // install 已执行
    expect(installFn).toHaveBeenCalled()
  })

  it('writes snapshot even when install fails (so state is recoverable)', async () => {
    const path = tmpPath()
    await performHotUpdate(snapshot, {
      installFn: vi.fn().mockRejectedValue(new Error('x')),
      spawnNewInstanceFn: vi.fn(),
      snapshotPath: path,
    })
    const written = JSON.parse(await readFile(path, 'utf8')) as { version: string }
    expect(written.version).toBe('0.1.0')
  })

  it('passes snapshot path with default --restore argv (no handoff)', async () => {
    const spawnFn = vi.fn().mockResolvedValue(undefined)
    await performHotUpdate(snapshot, {
      installFn: vi.fn().mockResolvedValue(undefined),
      spawnNewInstanceFn: spawnFn,
      snapshotPath: '/tmp/snap.json',
    })
    // [path, ...argv]
    expect(spawnFn).toHaveBeenCalledWith(
      '/tmp/snap.json',
      ['serve', '--restore', '/tmp/snap.json'],
      expect.anything(),
    )
  })

  it('appends --handoff-port <port> argv when handoffPort provided', async () => {
    const spawnFn = vi.fn().mockResolvedValue(undefined)
    await performHotUpdate(snapshot, {
      installFn: vi.fn().mockResolvedValue(undefined),
      spawnNewInstanceFn: spawnFn,
      snapshotPath: '/tmp/snap.json',
      handoffPort: 12345,
    })
    expect(spawnFn).toHaveBeenCalledWith(
      '/tmp/snap.json',
      ['serve', '--restore', '/tmp/snap.json', '--handoff-port', '12345'],
      expect.anything(),
    )
  })

  it('passes --host <host> argv when host provided（新实例接管同一绑定地址）', async () => {
    const spawnFn = vi.fn().mockResolvedValue(undefined)
    await performHotUpdate(snapshot, {
      installFn: vi.fn().mockResolvedValue(undefined),
      spawnNewInstanceFn: spawnFn,
      snapshotPath: '/tmp/snap.json',
      port: 3000,
      host: '0.0.0.0',
    })
    expect(spawnFn).toHaveBeenCalledWith(
      '/tmp/snap.json',
      ['serve', '--restore', '/tmp/snap.json', '--port', '3000', '--host', '0.0.0.0'],
      expect.anything(),
    )
  })

  it('honors custom restoreFlag in argv construction', async () => {
    const spawnFn = vi.fn().mockResolvedValue(undefined)
    await performHotUpdate(snapshot, {
      installFn: vi.fn().mockResolvedValue(undefined),
      spawnNewInstanceFn: spawnFn,
      snapshotPath: '/tmp/s.json',
      restoreFlag: '--resume-from',
    })
    expect(spawnFn).toHaveBeenCalledWith(
      '/tmp/s.json',
      ['serve', '--resume-from', '/tmp/s.json'],
      expect.anything(),
    )
  })
})

describe('cleanupSnapshot', () => {
  it('调用方指定的快照路径：只删除快照文件，绝不递归删除其父目录', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'c0de-snap-parent-'))
    try {
      const sibling = join(dir, 'precious.txt')
      await writeFile(sibling, 'keep me', 'utf8')
      const snapshotPath = join(dir, 'snapshot.json')
      await writeFile(snapshotPath, '{}', 'utf8')

      await cleanupSnapshot(snapshotPath)

      // 修复前：rm(join(path, '..'), { recursive, force }) 把整个父目录连带
      // 同目录下的无关文件一起删除——调用方传入自有路径时是灾难性数据丢失。
      expect(existsSync(dir)).toBe(true)
      expect(existsSync(sibling)).toBe(true)
      expect(existsSync(snapshotPath)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('不存在的快照路径：静默无操作（不抛错）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'c0de-snap-missing-'))
    try {
      await cleanupSnapshot(join(dir, 'no-such-snapshot.json'))
      expect(existsSync(dir)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writeSnapshot 自建的临时目录：整目录清理（快照落盘的 mkdtemp 目录归模块所有）', async () => {
    const r = await performHotUpdate(snapshot, {
      installFn: vi.fn().mockResolvedValue(undefined),
      spawnNewInstanceFn: vi.fn().mockResolvedValue(undefined),
    })
    if (r._tag !== 'success') throw new Error(`expected success, got ${r._tag}`)
    const dir = join(r.snapshotPath, '..')
    expect(existsSync(dir)).toBe(true)
    await cleanupSnapshot(r.snapshotPath)
    expect(existsSync(dir)).toBe(false)
  })
})

describe('waitForProgramChange', () => {
  it('变更检测正常 resolve 后摘除 abort 监听器（同型：executor/bash 的终结清理口径）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'c0de-wait-'))
    try {
      const file = join(dir, 'entry.js')
      await writeFile(file, 'v1', 'utf8')
      const before = await stat(file)
      const baseline = new Map([[file, { size: before.size, mtimeMs: before.mtimeMs }]])
      const controller = new AbortController()

      // 启动后改写文件 → changed() 命中 → resolve（正常终结路径，不触发 abort）
      const waitPromise = waitForProgramChange(60_000, baseline, controller.signal, 10)
      await new Promise((r) => setTimeout(r, 30))
      await writeFile(file, 'v2-longer', 'utf8')
      await waitPromise

      // 修复前：{ once: true } 只在「真的触发 abort」时自动摘除——正常 resolve
      // 的调用在信号上残留监听器，长生命周期信号复用场景下累积到第 11 个即
      // 触发 Node MaxListenersExceededWarning，闭包也随信号长期滞留。
      expect(getEventListeners(controller.signal, 'abort').length).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('abort 触发时 reject 且监听器不残留（once 语义自身已清理）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'c0de-wait-abort-'))
    try {
      const file = join(dir, 'entry.js')
      await writeFile(file, 'v1', 'utf8')
      const before = await stat(file)
      const baseline = new Map([[file, { size: before.size, mtimeMs: before.mtimeMs }]])
      const controller = new AbortController()
      const waitPromise = waitForProgramChange(60_000, baseline, controller.signal, 10)
      controller.abort()
      await expect(waitPromise).rejects.toThrow(/aborted/)
      expect(getEventListeners(controller.signal, 'abort').length).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
