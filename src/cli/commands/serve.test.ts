import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
        started.push({ port: opts.port ?? 7310 })
        return {
          port: opts.port ?? 7310,
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
    expect(first?.port).toBe(7310)
    expect(banners.join('')).toContain('7310')
    expect(opens[0]).toContain('7310')
    expect(closed).toBe(true)
  })

  it('respects --port and --no-open', async () => {
    const opens: string[] = []
    await runServeCommand({
      args: { options: { port: 4000, open: false }, positionals: [] },
      cwd: process.cwd(),
      serverStarter: async (opts) => ({ port: opts.port ?? 7310, close: async () => {} }),
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
        port: opts.port ?? 7310,
        authToken: 'tok-abc',
        close: async () => {},
      }),
      banner: () => {},
      opener: (url) => {
        opens.push(url)
      },
      hold: false,
    })
    expect(opens[0]).toBe('http://localhost:7310?token=tok-abc')
  })

  // 回归：非回环判定用 host.startsWith('127.')——以 127. 开头的**域名**
  //（127.example.com 等，可解析到任意公网地址）被误判为回环，非回环绑定
  // 的安全警告被静默跳过。只有点分 IPv4 字面量（首段 127）才是回环。
  describe('非回环监听警告', () => {
    let warns: string[]
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      warns.push(args.join(' '))
    })
    const starter = async (opts: { host?: string }) => ({
      port: opts.port ?? 7310,
      close: async () => {},
    })

    beforeEach(() => {
      warns = []
      warnSpy.mockClear()
    })

    afterEach(() => {
      warnSpy.mockClear()
    })

    async function serveOn(host: string): Promise<void> {
      await runServeCommand({
        args: { options: { host }, positionals: [] },
        cwd: process.cwd(),
        serverStarter: starter,
        banner: () => {},
        opener: () => {},
        hold: false,
      })
    }

    it('127.x.x.x 点分字面量 → 回环，不警告', async () => {
      await serveOn('127.0.0.1')
      await serveOn('127.8.8.8')
      expect(warns).toHaveLength(0)
    })

    it('以 127. 开头的域名/非点分串 → 非回环，必须警告', async () => {
      await serveOn('127.example.com')
      expect(warns.join('')).toContain('非回环')
      warns = []
      await serveOn('0.0.0.0')
      expect(warns.join('')).toContain('非回环')
    })
  })
})
