import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { performHotUpdate } from './updater.js'

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
    expect(installFn).toHaveBeenCalledWith('c0de-agent')
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
})
