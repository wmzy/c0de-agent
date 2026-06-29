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

  it('--apply runs install then spawn via performHotUpdate', async () => {
    const installFn = vi.fn().mockResolvedValue(undefined)
    const spawnFn = vi.fn().mockResolvedValue(undefined)
    const out = vi.fn()
    const r = await runUpdateCommand({
      args: { options: { apply: true }, positionals: [] },
      cwd: '/tmp',
      checkFn: async () => ({ hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' }),
      updateOpts: { installFn, spawnNewInstanceFn: spawnFn },
      out,
    })
    expect(r).toBeUndefined()
    expect(installFn).toHaveBeenCalledWith('c0de-agent')
    expect(spawnFn).toHaveBeenCalled()
    expect(out.mock.calls.flat().join(' ')).toContain('热更新完成')
  })
})
