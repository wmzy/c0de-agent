import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('/compact 声明压缩意图，返回 compact 变体（实际压缩由消费方执行）', async () => {
    const cmd = builtinCommands.find((c) => c.name === 'compact')
    expect(cmd).toBeDefined()
    const result = (await cmd?.execute('', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('compact')
  })
})

describe('workflow command', () => {
  it('is registered in builtin commands', () => {
    const reg = createSlashRegistry()
    expect(reg.has('workflow')).toBe(true)
  })

  it('/workflow without subcommand lists available workflows', async () => {
    const reg = createSlashRegistry()
    const cmd = reg.get('workflow')!
    const result = (await cmd.execute('', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('text')
    if (result._tag === 'text') {
      expect(result.text).toContain('Available')
    }
  })

  it('/workflow show <name> displays source code', async () => {
    const reg = createSlashRegistry()
    const cmd = reg.get('workflow')!
    const result = (await cmd.execute('show security-audit', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('text')
    if (result._tag === 'text') {
      expect(result.text).toContain('security-audit')
    }
  })

  it('/workflow show <unknown> returns error', async () => {
    const reg = createSlashRegistry()
    const cmd = reg.get('workflow')!
    const result = (await cmd.execute('show nonexistent', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('error')
  })

  it('/workflow run <unknown> returns error', async () => {
    const reg = createSlashRegistry()
    const cmd = reg.get('workflow')!
    const result = (await cmd.execute('run nonexistent', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.message).toContain('nonexistent')
    }
  })

  it('/workflow create saves workflow from file and reloads registry', async () => {
    // 准备临时项目目录和工作流源码文件
    const projDir = await mkdtemp(join(tmpdir(), 'wf-create-'))
    const sourceFile = join(projDir, 'my-audit.js')
    const wfSource = `
export const meta = { name: 'my-audit', description: 'test create', phases: ['scan'] }
export default async function workflow(ctx) {
  return { output: 'created' }
}
`
    await writeFile(sourceFile, wfSource, 'utf-8')

    const reg = createSlashRegistry()
    const cmd = reg.get('workflow')!
    const result = (await cmd.execute(`create my-audit --file ${sourceFile}`, {
      cwd: projDir,
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult

    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.message).toContain('my-audit')
      expect(result.message).toContain('saved')
    }

    // 验证文件被写入 .c0de/workflows/
    const { readFile } = await import('node:fs/promises')
    const savedPath = join(projDir, '.c0de/workflows', 'my-audit.js')
    const savedContent = await readFile(savedPath, 'utf-8')
    expect(savedContent).toContain('test create')

    await rm(projDir, { recursive: true, force: true })
  })

  it('/workflow create without --file returns error', async () => {
    const reg = createSlashRegistry()
    const cmd = reg.get('workflow')!
    const result = (await cmd.execute('create my-wf', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.message).toContain('--file')
    }
  })

  it('/workflow create with unreadable file returns error', async () => {
    const reg = createSlashRegistry()
    const cmd = reg.get('workflow')!
    const result = (await cmd.execute('create my-wf --file /nonexistent/path.js', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.message).toContain('Cannot read')
    }
  })

  it('/workflow list shows create/edit in usage', async () => {
    const reg = createSlashRegistry()
    const cmd = reg.get('workflow')!
    const result = (await cmd.execute('list', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('text')
    if (result._tag === 'text') {
      expect(result.text).toContain('create')
      expect(result.text).toContain('edit')
    }
  })
})
