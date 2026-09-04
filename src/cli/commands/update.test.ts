import { describe, expect, it, vi } from 'vitest'
import { runUpdateCommand } from './update.js'

const noArgs = { options: {}, positionals: [] }

describe('runUpdateCommand', () => {
  it('check-only: reports up-to-date', async () => {
    const out = vi.fn()
    await runUpdateCommand({
      args: noArgs,
      cwd: '/tmp',
      checkFn: async () => ({ hasUpdate: false, currentVersion: '0.1.0', latestVersion: '0.1.0' }),
      out,
    })
    expect(out.mock.calls.flat().join(' ')).toContain('已是最新')
  })

  it('check-only: hints --apply when update available', async () => {
    const out = vi.fn()
    await runUpdateCommand({
      args: noArgs,
      cwd: '/tmp',
      checkFn: async () => ({ hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' }),
      out,
    })
    expect(out.mock.calls.flat().join(' ')).toContain('--apply')
  })

  it('--apply 无 db：仅安装不 spawn serve（独立 CLI 场景）', async () => {
    const installFn = vi.fn().mockResolvedValue(undefined)
    const spawnFn = vi.fn().mockResolvedValue(undefined)
    const out = vi.fn()
    await runUpdateCommand({
      args: { options: { apply: true }, positionals: [] },
      cwd: '/tmp',
      checkFn: async () => ({ hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' }),
      updateOpts: { installFn, spawnNewInstanceFn: spawnFn },
      out,
    })
    expect(installFn).toHaveBeenCalledWith('c0de-agent', expect.anything())
    expect(spawnFn).not.toHaveBeenCalled()
    expect(out.mock.calls.flat().join(' ')).toContain('安装完成')
  })

  it('--apply 有 db：走 performHotUpdate 完整热更新', async () => {
    const installFn = vi.fn().mockResolvedValue(undefined)
    const spawnFn = vi.fn().mockResolvedValue(undefined)
    const out = vi.fn()
    const db = {
      db: {
        select: vi.fn(() => ({ from: vi.fn().mockResolvedValue([]) })),
      },
    } as unknown as import('../../db/client.js').DB
    await runUpdateCommand({
      args: { options: { apply: true }, positionals: [] },
      cwd: '/tmp',
      db,
      checkFn: async () => ({ hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' }),
      updateOpts: { installFn, spawnNewInstanceFn: spawnFn },
      out,
    })
    expect(spawnFn).toHaveBeenCalled()
    expect(out.mock.calls.flat().join(' ')).toContain('热更新完成')
  })

  it('--apply 安装失败：输出失败信息', async () => {
    const installFn = vi.fn().mockRejectedValue(new Error('npm EPERM'))
    const out = vi.fn()
    await runUpdateCommand({
      args: { options: { apply: true }, positionals: [] },
      cwd: '/tmp',
      checkFn: async () => ({ hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' }),
      updateOpts: { installFn },
      out,
    })
    expect(out.mock.calls.flat().join(' ')).toContain('安装失败')
  })
})
