import { describe, expect, it } from 'vitest'
import { BUILTIN_WORKFLOWS } from './builtins.js'
import type { WorkflowContext, WorkflowResult } from './types.js'

/** Minimal mock ctx for testing builtin execution. */
function makeMockCtx(overrides?: Partial<WorkflowContext>): WorkflowContext {
  return {
    project: { rootDir: '/tmp', name: 'test' },
    args: '',
    runSubagent: async () => ({ ok: true, output: '{}' }),
    runSubagents: async () => [{ ok: true, output: '{}' }],
    progress: () => {},
    utils: {
      glob: async () => [],
      grep: async () => [],
      read: async () => '',
      splitByDirectory: async () => [{ name: 'mod1', path: '/tmp/mod1', files: [] }],
    },
    ...overrides,
  }
}

describe('BUILTIN_WORKFLOWS', () => {
  it('has exactly 3 builtin workflows', () => {
    expect(BUILTIN_WORKFLOWS.length).toBe(3)
  })

  it('all have correct source = builtin', () => {
    for (const wf of BUILTIN_WORKFLOWS) {
      expect(wf.source).toBe('builtin')
    }
  })

  it('security-audit meta is correct', () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'security-audit')
    expect(wf).toBeDefined()
    expect(wf?.meta.description).toContain('安全审计')
    expect(wf?.meta.phases).toEqual(['scan', 'verify', 'report'])
  })

  it('code-review meta is correct', () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'code-review')
    expect(wf).toBeDefined()
    expect(wf?.meta.description).toContain('代码审查')
    expect(wf?.meta.phases).toEqual(['review', 'merge'])
  })

  it('migration-check meta is correct', () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'migration-check')
    expect(wf).toBeDefined()
    expect(wf?.meta.description).toContain('迁移')
  })

  it('security-audit executes and returns output', async () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'security-audit')
    const ctx = makeMockCtx({
      runSubagents: async (_type, tasks) =>
        tasks.map(() => ({ ok: true, output: JSON.stringify({ findings: [] }) })),
    })
    const result: WorkflowResult = await wf!.execute(ctx)
    expect(result.output).toBeDefined()
    expect(typeof result.output).toBe('string')
  })

  it('code-review executes and returns output', async () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'code-review')
    const ctx = makeMockCtx({
      runSubagents: async (_type, tasks) =>
        tasks.map(() => ({
          ok: true,
          output: JSON.stringify({ findings: [] }),
        })),
    })
    const result = await wf!.execute(ctx)
    expect(result.output).toBeDefined()
  })

  it('migration-check executes and returns output', async () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'migration-check')
    const ctx = makeMockCtx()
    const result = await wf!.execute(ctx)
    expect(result.output).toBeDefined()
  })

  it('all have sourceCode for /workflow show', () => {
    for (const wf of BUILTIN_WORKFLOWS) {
      expect(wf.sourceCode).toBeDefined()
      expect(wf.sourceCode?.length).toBeGreaterThan(0)
    }
  })
})
