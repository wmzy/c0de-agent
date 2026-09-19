import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runConfigCommand } from './config.js'

const tmp = join(tmpdir(), `c0de-configcmd-test-${Date.now()}`)
beforeEach(() => mkdirSync(tmp, { recursive: true }))
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function seedConfig(obj: unknown): void {
  mkdirSync(join(tmp, '.c0de'), { recursive: true })
  writeFileSync(join(tmp, '.c0de', 'config.json'), JSON.stringify(obj))
}

describe('config get', () => {
  it('prints whole config when no key', async () => {
    seedConfig({ defaultModel: 'gpt-4o', defaultProvider: 'openai' })
    const out: string[] = []
    await runConfigCommand({
      args: { options: {}, positionals: ['get'] },
      cwd: tmp,
      write: (s) => out.push(s),
    })
    const parsed = JSON.parse(out.join(''))
    expect(parsed.defaultModel).toBe('gpt-4o')
  })

  it('prints dotted path value', async () => {
    seedConfig({ defaultModel: 'gpt-4o', compaction: { threshold: 0.9 } })
    const out: string[] = []
    await runConfigCommand({
      args: { options: {}, positionals: ['get', 'compaction.threshold'] },
      cwd: tmp,
      write: (s) => out.push(s),
    })
    expect(out.join('').trim()).toBe('0.9')
  })

  it('errors on unknown key', async () => {
    seedConfig({ defaultModel: 'gpt-4o' })
    await expect(
      runConfigCommand({
        args: { options: {}, positionals: ['get', 'nope'] },
        cwd: tmp,
        write: () => {},
      }),
    ).rejects.toThrow(/not found/i)
  })
})

describe('config set', () => {
  /** 指纹刷新注入：测试不得触达真实持久库（PGLite dataDir）。 */
  const ctxWithMockRefresh = (args: {
    options: Record<string, unknown>
    positionals: string[]
  }) => ({
    args,
    cwd: tmp,
    write: () => {},
    refreshTrust: vi.fn(),
  })

  it('writes top-level value', async () => {
    seedConfig({ defaultModel: 'gpt-4o' })
    await runConfigCommand(
      ctxWithMockRefresh({ options: {}, positionals: ['set', 'defaultModel', 'gpt-5'] }),
    )
    const cfg = JSON.parse(readFileSync(join(tmp, '.c0de', 'config.json'), 'utf-8'))
    expect(cfg.defaultModel).toBe('gpt-5')
  })

  it('errors when no value', async () => {
    seedConfig({ defaultModel: 'gpt-4o' })
    await expect(
      runConfigCommand(ctxWithMockRefresh({ options: {}, positionals: ['set', 'defaultModel'] })),
    ).rejects.toThrow(/value/i)
  })

  it('set null 删除该键（unset，回落全局/默认值）', async () => {
    seedConfig({ defaultModel: 'proj-model', theme: 'dark' })
    const out: string[] = []
    const ctx = ctxWithMockRefresh({ options: {}, positionals: ['set', 'defaultModel', 'null'] })
    await runConfigCommand({ ...ctx, write: (s) => out.push(s) })
    const cfg = JSON.parse(readFileSync(join(tmp, '.c0de', 'config.json'), 'utf-8'))
    expect(cfg).toEqual({ theme: 'dark' })
    expect(out.join('')).toContain('已取消设置')
  })

  it('set 嵌套点路径只改目标键，不覆盖同层其它键', async () => {
    seedConfig({ compaction: { threshold: 0.5, reserveTokens: 1000 } })
    await runConfigCommand(
      ctxWithMockRefresh({ options: {}, positionals: ['set', 'compaction.threshold', '0.9'] }),
    )
    const cfg = JSON.parse(readFileSync(join(tmp, '.c0de', 'config.json'), 'utf-8'))
    expect(cfg.compaction).toEqual({ threshold: 0.9, reserveTokens: 1000 })
  })

  it('P1：项目作用域写入后调用指纹刷新（防自锁复检）', async () => {
    seedConfig({ permission: { defaultMode: 'ask' } })
    const ctx = ctxWithMockRefresh({
      options: {},
      positionals: ['set', 'permission.defaultMode', 'auto'],
    })
    await runConfigCommand(ctx)
    expect(ctx.refreshTrust).toHaveBeenCalledTimes(1)
    expect(ctx.refreshTrust).toHaveBeenCalledWith(tmp)
  })

  it('P1：--global 写入不触发指纹刷新（项目信任面未变）', async () => {
    seedConfig({ defaultModel: 'gpt-4o' })
    const ctx = ctxWithMockRefresh({
      options: { global: true },
      positionals: ['set', 'defaultModel', 'gpt-5'],
    })
    await runConfigCommand(ctx)
    expect(ctx.refreshTrust).not.toHaveBeenCalled()
  })

  it('项目作用域写入 security → 拒绝并引导 --global（服务端全局参数）', async () => {
    seedConfig({ defaultModel: 'gpt-4o' })
    await expect(
      runConfigCommand(
        ctxWithMockRefresh({
          options: {},
          positionals: ['set', 'security.authEnabled', 'false'],
        }),
      ),
    ).rejects.toThrow(/--global/)
    const cfg = JSON.parse(readFileSync(join(tmp, '.c0de', 'config.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(cfg.security).toBeUndefined()
  })
})
