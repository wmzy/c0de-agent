import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  it('writes top-level value', async () => {
    seedConfig({ defaultModel: 'gpt-4o' })
    await runConfigCommand({
      args: { options: {}, positionals: ['set', 'defaultModel', 'gpt-5'] },
      cwd: tmp,
      write: () => {},
    })
    const cfg = JSON.parse(readFileSync(join(tmp, '.c0de', 'config.json'), 'utf-8'))
    expect(cfg.defaultModel).toBe('gpt-5')
  })

  it('errors when no value', async () => {
    seedConfig({ defaultModel: 'gpt-4o' })
    await expect(
      runConfigCommand({
        args: { options: {}, positionals: ['set', 'defaultModel'] },
        cwd: tmp,
        write: () => {},
      }),
    ).rejects.toThrow(/value/i)
  })
})
