import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createDefaultRegistry } from '../../tools/index.js'
import { autoAllowChecker } from '../../tools/permission.js'
import { DEFAULT_CONFIG } from '../config.js'
import type { AgentDependencies } from '../types.js'
import { createAndPopulateRegistry } from './index.js'
import { executeWorkflow } from './runtime.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'wf-int-'))
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('workflow end-to-end', () => {
  it('discovers and registers a custom .c0de/workflows/*.js workflow', async () => {
    // 写入自定义工作流
    const wfSource = `
export const meta = {
  name: 'echo-test',
  description: 'Echo test workflow',
}
export default async function workflow(ctx) {
  ctx.progress('starting echo')
  const result = await ctx.runSubagent('researcher', {
    assignment: 'just return "hello"',
    description: 'echo',
  })
  return { output: 'echo: ' + (result.ok ? result.output : result.error) }
}
`
    await mkdir(join(tmpDir, '.c0de/workflows'), { recursive: true })
    await writeFile(join(tmpDir, '.c0de/workflows', 'echo-test.js'), wfSource, 'utf-8')

    // 创建注册表
    const registry = await createAndPopulateRegistry(tmpDir)
    expect(registry.has('echo-test')).toBe(true)
    expect(registry.has('security-audit')).toBe(true) // 内置也在

    // 构建 mock deps
    const db = await createDB({ driver: 'pglite' })
    await migrateDB(db)
    const deps: AgentDependencies = {
      db,
      llmRegistry: {} as AgentDependencies['llmRegistry'],
      toolRegistry: createDefaultRegistry(),
      permission: autoAllowChecker,
      config: DEFAULT_CONFIG,
      cwd: tmpDir,
    } as AgentDependencies

    const mockParent = {
      session: { id: 'int-test', title: 'test', projectId: null },
      messages: [],
      config: { provider: 'test', model: 'test', tools: [], plugins: [], agentName: 'default' },
      status: { _tag: 'idle' },
      tools: [],
    } as unknown as Parameters<typeof executeWorkflow>[0]['parent']

    const result = await executeWorkflow({
      registry,
      name: 'echo-test',
      args: '',
      deps,
      parent: mockParent,
    })

    // 工作流会尝试调用 runSubAgent，但因为 llmRegistry 是 mock，会走到 error 分支
    // 这是预期的 — 测试验证的是工作流编排逻辑，不是 LLM 调用
    expect(result._tag).toBe('text')
    if (result._tag === 'text') {
      expect(result.text).toContain('echo:')
    }

    await db.close()
  })

  it('builtin workflow meta is correct after population', async () => {
    const registry = await createAndPopulateRegistry(tmpDir)
    const securityAudit = registry.get('security-audit')
    expect(securityAudit).toBeDefined()
    expect(securityAudit?.source).toBe('builtin')
    expect(securityAudit?.meta.phases).toEqual(['scan', 'verify', 'report'])

    const codeReview = registry.get('code-review')
    expect(codeReview).toBeDefined()
    expect(codeReview?.meta.phases).toEqual(['review', 'merge'])
  })

  it('project workflow overrides builtin with same name', async () => {
    const overrideSource = `
export const meta = { name: 'security-audit', description: 'custom override' }
export default async function workflow(ctx) {
  return { output: 'overridden' }
}
`
    await mkdir(join(tmpDir, '.c0de/workflows'), { recursive: true })
    await writeFile(join(tmpDir, '.c0de/workflows', 'security-audit.js'), overrideSource, 'utf-8')

    const registry = await createAndPopulateRegistry(tmpDir)
    const entry = registry.get('security-audit')
    expect(entry?.source).toBe('project')
    expect(entry?.meta.description).toBe('custom override')
  })
})
