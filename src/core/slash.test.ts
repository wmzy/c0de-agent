import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

  it('workflow 命令声明了 subcommands', () => {
    const reg = createSlashRegistry()
    const wf = reg.get('workflow')
    expect(wf?.subcommands).toBeDefined()
    expect(wf?.subcommands?.map((s) => s.name)).toEqual(['list', 'run', 'show', 'create', 'edit'])
    // 每个子命令必须有 description
    for (const sub of wf?.subcommands ?? []) {
      expect(sub.description.length).toBeGreaterThan(0)
    }
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
      expect(result.text).toContain('/compact')
      expect(result.text).toContain('/clear')
      expect(result.text).toContain('/fork')
      expect(result.text).toContain('/config')
      // /model 不再以「切换模型」姿态出现（已诚实化）
      expect(result.text).not.toContain('Switch the current session model')
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

  it('/config <key> 点路径读取', async () => {
    const cmd = builtinCommands.find((c) => c.name === 'config')
    expect(cmd).toBeDefined()
    const result = (await cmd?.execute('compaction.threshold', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('text')
    if (result._tag === 'text') {
      expect(result.text).toContain('compaction.threshold')
      expect(result.text).toContain('0.8')
    }
  })

  it('/config <key> <value> 写入 project 作用域文件', async () => {
    const projDir = await mkdtemp(join(tmpdir(), 'slash-config-'))
    const cmd = builtinCommands.find((c) => c.name === 'config')
    expect(cmd).toBeDefined()
    const result = (await cmd?.execute('defaultModel gpt-5', {
      cwd: projDir,
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('success')
    const { readFile } = await import('node:fs/promises')
    const saved = JSON.parse(await readFile(join(projDir, '.c0de/config.json'), 'utf-8')) as {
      defaultModel?: string
    }
    expect(saved.defaultModel).toBe('gpt-5')
    await rm(projDir, { recursive: true, force: true })
  })

  it('/config 未知键返回 error', async () => {
    const cmd = builtinCommands.find((c) => c.name === 'config')
    expect(cmd).toBeDefined()
    const result = (await cmd?.execute('nope.nope', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('error')
  })

  it('/model 诚实指引到模型选择器', async () => {
    const cmd = builtinCommands.find((c) => c.name === 'model')
    expect(cmd).toBeDefined()
    const result = (await cmd?.execute('gpt-4o', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('text')
    if (result._tag === 'text') {
      expect(result.text).toContain('模型选择器')
      expect(result.text).not.toContain('Model set to')
    }
  })

  it('/clear 缺 --yes 拒绝执行', async () => {
    const session = await createSession(db, 't')
    const { appendMessage } = await import('../session/message.js')
    await appendMessage(db, session.id, {
      role: 'user',
      content: [{ _tag: 'text', text: 'hello' }],
    })
    const cmd = builtinCommands.find((c) => c.name === 'clear')
    expect(cmd).toBeDefined()
    const result = (await cmd?.execute('', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
      sessionId: session.id,
    })) as CommandResult
    expect(result._tag).toBe('error')
    const { getEntries } = await import('../session/message.js')
    expect(await getEntries(db, session.id)).toHaveLength(1)
  })

  it('/clear --yes 归档并清空当前会话消息', async () => {
    const session = await createSession(db, 't')
    const { appendMessage, getEntries } = await import('../session/message.js')
    await appendMessage(db, session.id, {
      role: 'user',
      content: [{ _tag: 'text', text: 'hello' }],
    })
    const cmd = builtinCommands.find((c) => c.name === 'clear')
    expect(cmd).toBeDefined()
    const result = (await cmd?.execute('--yes', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
      sessionId: session.id,
    })) as CommandResult
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.message).toContain('Cleared 1')
    }
    expect(await getEntries(db, session.id)).toHaveLength(0)
    // 原始消息已归档（clear 类型）
    const { searchArchives } = await import('../session/archive.js')
    const archives = await searchArchives(db, session.id, 'hello')
    expect(archives.length).toBeGreaterThan(0)
    expect(archives.some((a) => a.archiveType === 'clear')).toBe(true)
  })

  it('/fork 默认当前会话最新消息分支', async () => {
    const session = await createSession(db, 't')
    const { appendMessage } = await import('../session/message.js')
    await appendMessage(db, session.id, { role: 'user', content: [{ _tag: 'text', text: 'one' }] })
    await appendMessage(db, session.id, { role: 'user', content: [{ _tag: 'text', text: 'two' }] })
    const cmd = builtinCommands.find((c) => c.name === 'fork')
    expect(cmd).toBeDefined()
    const result = (await cmd?.execute('', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
      sessionId: session.id,
    })) as CommandResult
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.message).toContain('Forked')
    }
  })

  it('/fork 空会话返回 EMPTY_SESSION 错误', async () => {
    const session = await createSession(db, 't')
    const cmd = builtinCommands.find((c) => c.name === 'fork')
    expect(cmd).toBeDefined()
    const result = (await cmd?.execute('', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
      sessionId: session.id,
    })) as CommandResult
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.message).toContain('EMPTY_SESSION')
    }
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
    const cmd = reg.get('workflow')
    const result = (await cmd?.execute('', {
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
    const cmd = reg.get('workflow')
    const result = (await cmd?.execute('show security-audit', {
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
    const cmd = reg.get('workflow')
    const result = (await cmd?.execute('show nonexistent', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('error')
  })

  it('/workflow run <unknown> returns error', async () => {
    const reg = createSlashRegistry()
    const cmd = reg.get('workflow')
    const result = (await cmd?.execute('run nonexistent', {
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
    const cmd = reg.get('workflow')
    const result = (await cmd?.execute(`create my-audit --file ${sourceFile}`, {
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
    const cmd = reg.get('workflow')
    const result = (await cmd?.execute('create my-wf', {
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
    const cmd = reg.get('workflow')
    const result = (await cmd?.execute('create my-wf --file /nonexistent/path.js', {
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
    const cmd = reg.get('workflow')
    const result = (await cmd?.execute('list', {
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

  it('/workflow show 发现项目级 .c0de/workflows/*.js', async () => {
    const projDir = await mkdtemp(join(tmpdir(), 'wf-proj-show-'))
    const wfDir = join(projDir, '.c0de', 'workflows')
    await mkdir(wfDir, { recursive: true })
    await writeFile(
      join(wfDir, 'proj-only.js'),
      `export const meta = { name: 'proj-only', description: 'project-level wf', phases: ['go'] }\nexport default async function wf(ctx) { return { output: 'ok' } }`,
    )

    const reg = createSlashRegistry()
    const cmd = reg.get('workflow')
    const result = (await cmd?.execute('show proj-only', {
      cwd: projDir,
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult

    expect(result._tag).toBe('text')
    if (result._tag === 'text') {
      expect(result.text).toContain('proj-only')
      expect(result.text).toContain('project-level wf')
    }

    await rm(projDir, { recursive: true, force: true })
  })

  it('/workflow list 合并项目级工作流', async () => {
    const projDir = await mkdtemp(join(tmpdir(), 'wf-proj-list-'))
    const wfDir = join(projDir, '.c0de', 'workflows')
    await mkdir(wfDir, { recursive: true })
    await writeFile(
      join(wfDir, 'list-test.js'),
      `export const meta = { name: 'list-test', description: 'listed from project', phases: ['go'] }\nexport default async function wf(ctx) { return { output: 'ok' } }`,
    )

    const reg = createSlashRegistry()
    const cmd = reg.get('workflow')
    const result = (await cmd?.execute('list', {
      cwd: projDir,
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult

    expect(result._tag).toBe('text')
    if (result._tag === 'text') {
      // builtin 仍在
      expect(result.text).toContain('security-audit')
      // 项目级出现
      expect(result.text).toContain('list-test')
      expect(result.text).toContain('project')
    }

    await rm(projDir, { recursive: true, force: true })
  })
})
