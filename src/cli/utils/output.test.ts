import { describe, expect, it } from 'vitest'
import { openBrowser, platformOpener } from './output.js'

describe('platformOpener', () => {
  it('returns open for darwin', () => {
    expect(platformOpener('darwin')).toEqual({ command: 'open', prefixArgs: [] })
  })
  it('routes win32 through cmd /c start (start 是内建命令，直接 spawn 必 ENOENT)', () => {
    expect(platformOpener('win32')).toEqual({ command: 'cmd', prefixArgs: ['/c', 'start', ''] })
  })
  it('returns xdg-open for linux', () => {
    expect(platformOpener('linux')).toEqual({ command: 'xdg-open', prefixArgs: [] })
  })
})

describe('openBrowser', () => {
  it('spawns the platform opener with the url', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    await openBrowser('http://localhost:3000', {
      platform: 'linux',
      spawnFn: (cmd, args) => {
        calls.push({ cmd, args })
        return { killed: false, kill() {} } as never
      },
    })
    const [first] = calls
    expect(first?.cmd).toBe('xdg-open')
    expect(first?.args).toContain('http://localhost:3000')
  })
  it('win32 经 cmd /c start 调用（空标题槽防 URL 被当成窗口标题）', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    await openBrowser('http://localhost:3000', {
      platform: 'win32',
      spawnFn: (cmd, args) => {
        calls.push({ cmd, args })
        return { killed: false, kill() {} } as never
      },
    })
    const [first] = calls
    expect(first?.cmd).toBe('cmd')
    expect(first?.args).toEqual(['/c', 'start', '', 'http://localhost:3000'])
  })
})
