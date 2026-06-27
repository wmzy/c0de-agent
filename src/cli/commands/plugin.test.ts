import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runPluginCommand } from './plugin.js'

const tmp = join(tmpdir(), `c0de-plugincmd-test-${Date.now()}`)
beforeEach(() => mkdirSync(tmp, { recursive: true }))
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function seedConfig(): void {
  mkdirSync(join(tmp, '.c0de'), { recursive: true })
  writeFileSync(join(tmp, '.c0de', 'config.json'), JSON.stringify({ plugins: { enabled: [] } }))
}

describe('plugin list', () => {
  it('lists discovered plugins', async () => {
    const out: string[] = []
    await runPluginCommand({
      args: { options: {}, positionals: ['list'] },
      cwd: tmp,
      discover: async () => [
        { name: 'p1', version: '1.0.0' },
        { name: 'p2', version: '2.0.0' },
      ] as never,
      write: (s) => out.push(s),
    })
    expect(out.join('')).toContain('p1')
    expect(out.join('')).toContain('p2')
  })

  it('handles no plugins', async () => {
    const out: string[] = []
    await runPluginCommand({
      args: { options: {}, positionals: ['list'] },
      cwd: tmp,
      discover: async () => [],
      write: (s) => out.push(s),
    })
    expect(out.join('')).toMatch(/no plugins|none/i)
  })
})

describe('plugin install', () => {
  it('adds name to plugins.enabled', async () => {
    seedConfig()
    const out: string[] = []
    await runPluginCommand({
      args: { options: {}, positionals: ['install', 'my-plugin'] },
      cwd: tmp,
      discover: async () => [],
      write: (s) => out.push(s),
    })
    const cfg = JSON.parse(readFileSync(join(tmp, '.c0de', 'config.json'), 'utf-8'))
    expect(cfg.plugins.enabled).toContain('my-plugin')
  })

  it('errors when no name', async () => {
    seedConfig()
    await expect(
      runPluginCommand({
        args: { options: {}, positionals: ['install'] },
        cwd: tmp,
        discover: async () => [],
        write: () => {},
      }),
    ).rejects.toThrow(/name/i)
  })
})
