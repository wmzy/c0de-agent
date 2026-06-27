import { describe, expect, it } from 'vitest'
import { runServeCommand } from './serve.js'

describe('runServeCommand', () => {
  it('starts server, prints banner, opens browser by default', async () => {
    let closed = false
    const started: { port: number }[] = []
    const banners: string[] = []
    const opens: string[] = []
    await runServeCommand({
      args: { options: {}, positionals: [] },
      cwd: process.cwd(),
      serverStarter: async (opts) => {
        started.push({ port: opts.port ?? 3000 })
        return { port: opts.port ?? 3000, close: () => { closed = true } }
      },
      banner: (s) => banners.push(s),
      opener: (url) => { opens.push(url) },
      hold: false,
    })
    expect(started[0].port).toBe(3000)
    expect(banners.join('')).toContain('3000')
    expect(opens[0]).toContain('3000')
    expect(closed).toBe(true)
  })

  it('respects --port and --no-open', async () => {
    const opens: string[] = []
    await runServeCommand({
      args: { options: { port: 4000, open: false }, positionals: [] },
      cwd: process.cwd(),
      serverStarter: async (opts) => ({ port: opts.port ?? 3000, close: () => {} }),
      banner: () => {},
      opener: (url) => { opens.push(url) },
      hold: false,
    })
    expect(opens).toHaveLength(0)
  })
})
