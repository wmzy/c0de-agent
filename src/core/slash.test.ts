import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { createSession } from '../session/session.js'
import { createDefaultRegistry } from '../tools/index.js'
import { autoAllowChecker } from '../tools/permission.js'
import { DEFAULT_CONFIG } from './config.js'
import { builtinCommands, createSlashRegistry, parseSlashInput } from './slash.js'
import type { AgentDependencies, CommandResult } from './types.js'

let db: DB
let deps: AgentDependencies

beforeEach(async () => {
  db = await createDB({ driver: 'pglite' })
  await migrateDB(db)
  deps = {
    db,
    llmRegistry: {} as AgentDependencies['llmRegistry'],
    toolRegistry: createDefaultRegistry(),
    permission: autoAllowChecker,
    config: DEFAULT_CONFIG,
    cwd: process.cwd(),
  } as AgentDependencies
})
afterEach(async () => {
  await db.close()
})

describe('parseSlashInput', () => {
  it('parses command without args', () => {
    const parsed = parseSlashInput('/help')
    expect(parsed?.name).toBe('help')
    expect(parsed?.args).toBe('')
  })

  it('parses command with args', () => {
    const parsed = parseSlashInput('/model gpt-4o')
    expect(parsed?.name).toBe('model')
    expect(parsed?.args).toBe('gpt-4o')
  })

  it('returns null for non-slash input', () => {
    expect(parseSlashInput('hello')).toBeNull()
  })
})

describe('slash registry', () => {
  it('registers and retrieves commands', () => {
    const reg = createSlashRegistry()
    expect(reg.has('help')).toBe(true)
    expect(reg.has('compact')).toBe(true)
    expect(reg.get('help')?.name).toBe('help')
  })

  it('lists all builtin commands', () => {
    const reg = createSlashRegistry()
    const names = reg.list().map((c) => c.name)
    expect(names).toContain('help')
    expect(names).toContain('compact')
    expect(names).toContain('model')
    expect(names).toContain('clear')
    expect(names).toContain('fork')
    expect(names).toContain('config')
  })
})

describe('builtin commands', () => {
  it('/help returns text listing commands', async () => {
    const cmd = builtinCommands.find((c) => c.name === 'help')
    expect(cmd).toBeDefined()
    const result = (await cmd?.execute('', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('text')
    if (result._tag === 'text') {
      expect(result.text).toContain('compact')
      expect(result.text).toContain('model')
    }
  })

  it('/config without args shows current config', async () => {
    const cmd = builtinCommands.find((c) => c.name === 'config')
    expect(cmd).toBeDefined()
    const result = (await cmd?.execute('', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('text')
  })

  it('/clear clears session messages', async () => {
    const session = await createSession(db, 't')
    const { appendMessage } = await import('../session/message.js')
    await appendMessage(db, session.id, {
      role: 'user',
      content: [{ _tag: 'text', text: 'hello' }],
    })
    const cmd = builtinCommands.find((c) => c.name === 'clear')
    expect(cmd).toBeDefined()
    const result = (await cmd?.execute(session.id, {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('success')
  })
})
