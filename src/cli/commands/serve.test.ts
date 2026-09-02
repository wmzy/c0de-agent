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
        return {
          port: opts.port ?? 3000,
          close: async () => {
            closed = true
          },
        }
      },
      banner: (s) => banners.push(s),
      opener: (url) => {
        opens.push(url)
      },
      hold: false,
    })
    const [first] = started
    expect(first?.port).toBe(3000)
    expect(banners.join('')).toContain('3000')
    expect(opens[0]).toContain('3000')
    expect(closed).toBe(true)
  })

  it('respects --port and --no-open', async () => {
    const opens: string[] = []
    await runServeCommand({
      args: { options: { port: 4000, open: false }, positionals: [] },
      cwd: process.cwd(),
      serverStarter: async (opts) => ({ port: opts.port ?? 3000, close: async () => {} }),
      banner: () => {},
      opener: (url) => {
        opens.push(url)
      },
      hold: false,
    })
    expect(opens).toHaveLength(0)
  })

  it('appends ?token= to URL when server reports authToken', async () => {
    const opens: string[] = []
    await runServeCommand({
      args: { options: {}, positionals: [] },
      cwd: process.cwd(),
      serverStarter: async (opts) => ({
        port: opts.port ?? 3000,
        authToken: 'tok-abc',
        close: async () => {},
      }),
      banner: () => {},
      opener: (url) => {
        opens.push(url)
      },
      hold: false,
    })
    expect(opens[0]).toBe('http://localhost:3000?token=tok-abc')
  })
})
