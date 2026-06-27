import { describe, expect, it } from 'vitest'
import { openBrowser, platformOpener } from './output.js'

describe('platformOpener', () => {
  it('returns open for darwin', () => {
    expect(platformOpener('darwin')).toBe('open')
  })
  it('returns start for win32', () => {
    expect(platformOpener('win32')).toBe('start')
  })
  it('returns xdg-open for linux', () => {
    expect(platformOpener('linux')).toBe('xdg-open')
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
})
