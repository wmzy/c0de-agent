import { describe, expect, it } from 'vitest'
import type {
  WorkflowAgentResult,
  WorkflowContext,
  WorkflowEntry,
  WorkflowMeta,
  WorkflowModule,
  WorkflowResult,
  WorkflowUtils,
} from './types.js'

describe('Workflow types', () => {
  it('WorkflowMeta accepts required fields', () => {
    const meta: WorkflowMeta = {
      name: 'security-audit',
      description: '安全审计',
      argsHint: '[target]',
      phases: ['scan', 'verify', 'report'],
    }
    expect(meta.name).toBe('security-audit')
  })

  it('WorkflowMeta works without optional fields', () => {
    const meta: WorkflowMeta = { name: 'simple', description: '简单' }
    expect(meta.name).toBe('simple')
    expect(meta.phases).toBeUndefined()
  })

  it('WorkflowResult accepts output and data', () => {
    const r: WorkflowResult = { output: 'done', data: { count: 3 } }
    expect(r.output).toBe('done')
  })

  it('WorkflowAgentResult discriminated union works', () => {
    const ok: WorkflowAgentResult = { ok: true, output: 'scanned', data: [] }
    const fail: WorkflowAgentResult = { ok: false, error: 'timeout' }
    expect(ok.ok).toBe(true)
    expect(fail.ok).toBe(false)
  })

  it('WorkflowEntry has execute and source', () => {
    const entry: WorkflowEntry = {
      meta: { name: 'test', description: 'test wf' },
      source: 'builtin',
      execute: async () => ({ output: 'ok' }),
    }
    expect(entry.source).toBe('builtin')
    expect(typeof entry.execute).toBe('function')
  })

  it('WorkflowContext shape is correct', () => {
    const ctx: WorkflowContext = {
      project: { rootDir: '/tmp', name: 'test' },
      args: '',
      runSubagent: async () => ({ ok: true, output: '' }),
      runSubagents: async () => [],
      progress: () => {},
      utils: {
        glob: async () => [],
        grep: async () => [],
        read: async () => '',
        splitByDirectory: async () => [],
      },
    }
    expect(ctx.project.rootDir).toBe('/tmp')
  })

  it('WorkflowUtils type compiles', () => {
    const utils: WorkflowUtils = {
      glob: async () => [],
      grep: async () => [],
      read: async () => '',
      splitByDirectory: async () => [],
    }
    expect(typeof utils.glob).toBe('function')
  })

  it('WorkflowModule type compiles', () => {
    const mod: WorkflowModule = {
      meta: { name: 'test', description: 'x' },
      default: async () => ({ output: 'done' }),
    }
    expect(mod.meta.name).toBe('test')
  })
})