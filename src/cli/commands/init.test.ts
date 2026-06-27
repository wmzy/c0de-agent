import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInitCommand } from './init.js'

const tmp = join(tmpdir(), `c0de-init-test-${Date.now()}`)
beforeEach(() => mkdirSync(tmp, { recursive: true }))
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('runInitCommand', () => {
  it('creates .c0de/config.json with defaults', async () => {
    const messages: string[] = []
    await runInitCommand({
      args: { options: {}, positionals: [] },
      cwd: tmp,
      log: (s) => messages.push(s),
    })
    const path = join(tmp, '.c0de', 'config.json')
    expect(existsSync(path)).toBe(true)
    const cfg = JSON.parse(readFileSync(path, 'utf-8'))
    expect(cfg.defaultProvider).toBe('openai')
    expect(messages.join('')).toContain('Created')
  })

  it('errors when config exists without --force', async () => {
    await runInitCommand({ args: { options: {}, positionals: [] }, cwd: tmp, log: () => {} })
    await expect(
      runInitCommand({ args: { options: {}, positionals: [] }, cwd: tmp, log: () => {} }),
    ).rejects.toThrow(/exists/i)
  })

  it('overwrites with --force', async () => {
    await runInitCommand({ args: { options: {}, positionals: [] }, cwd: tmp, log: () => {} })
    await runInitCommand({
      args: { options: { force: true }, positionals: [] },
      cwd: tmp,
      log: () => {},
    })
    const path = join(tmp, '.c0de', 'config.json')
    expect(existsSync(path)).toBe(true)
  })
})
