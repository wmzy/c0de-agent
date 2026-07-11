import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubAgentResult } from '../../shared/types/tool.js'
import type { AgentDependencies, AgentState } from '../types.js'
import { buildWorkflowContext } from './context.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'wf-ctx-'))
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function makeMockDeps(): AgentDependencies {
  return {
    db: {} as AgentDependencies['db'],
    llmRegistry: {} as AgentDependencies['llmRegistry'],
    toolRegistry: {} as AgentDependencies['toolRegistry'],
    permission: {} as AgentDependencies['permission'],
    config: {} as AgentDependencies['config'],
    cwd: tmpDir,
    agentRegistry: {
      get: () => ({ name: 'test', description: '', systemPrompt: '', mode: 'subagent' }),
    },
  } as unknown as AgentDependencies
}

function makeMockParent(): AgentState {
  return {
    session: { id: 'test-session', title: 'test', projectId: null },
    messages: [],
    config: { provider: 'test', model: 'test', tools: [], plugins: [], agentName: 'default' },
    status: { _tag: 'idle' },
    tools: [],
  } as unknown as AgentState
}

describe('buildWorkflowContext', () => {
  it('creates context with project info', () => {
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: 'test-args',
      onProgress: () => {},
      projectName: 'my-project',
    })
    expect(ctx.project.rootDir).toBe(tmpDir)
    expect(ctx.project.name).toBe('my-project')
    expect(ctx.args).toBe('test-args')
  })

  it('runSubagent delegates to runSubAgent and maps success', async () => {
    const runSubAgentFn = vi.fn().mockResolvedValue({
      _tag: 'success',
      output: 'task done',
      sessionId: 'child-1',
      data: { result: 'ok' },
    } satisfies SubAgentResult)
    const deps = makeMockDeps()
    const ctx = buildWorkflowContext({
      deps,
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
      runSubAgentFn,
    })
    const result = await ctx.runSubagent('researcher', { assignment: 'do stuff' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.output).toBe('task done')
      expect(result.data).toEqual({ result: 'ok' })
    }
    expect(runSubAgentFn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'researcher',
        prompt: 'do stuff',
      }),
    )
  })

  it('runSubagent maps error result', async () => {
    const runSubAgentFn = vi.fn().mockResolvedValue({
      _tag: 'error',
      error: 'agent failed',
    } satisfies SubAgentResult)
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
      runSubAgentFn,
    })
    const result = await ctx.runSubagent('coder', { assignment: 'fail task' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('agent failed')
    }
  })

  it('runSubagents runs all tasks and returns ordered results', async () => {
    let callCount = 0
    const runSubAgentFn = vi.fn().mockImplementation(() => {
      callCount++
      return Promise.resolve({
        _tag: 'success' as const,
        output: `result-${callCount}`,
        sessionId: `s-${callCount}`,
      })
    })
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
      runSubAgentFn,
    })
    const results = await ctx.runSubagents('coder', [
      { assignment: 'task1' },
      { assignment: 'task2' },
      { assignment: 'task3' },
    ])
    expect(results.length).toBe(3)
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('progress callback fires', () => {
    const onProgress = vi.fn()
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress,
    })
    ctx.progress('step 1', { phase: 'scan' })
    expect(onProgress).toHaveBeenCalledWith('step 1', { phase: 'scan' })
  })

  it('utils.glob finds files', async () => {
    await mkdir(join(tmpDir, 'sub'), { recursive: true })
    await writeFile(join(tmpDir, 'a.ts'), 'x')
    await writeFile(join(tmpDir, 'b.ts'), 'y')
    await writeFile(join(tmpDir, 'sub', 'c.ts'), 'z')
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
    })
    const files = await ctx.utils.glob('*.ts')
    expect(files.length).toBeGreaterThanOrEqual(2)
  })

  it('utils.read reads file content', async () => {
    await writeFile(join(tmpDir, 'hello.txt'), 'line1\nline2\nline3')
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
    })
    const content = await ctx.utils.read('hello.txt')
    expect(content).toContain('line1')
  })

  it('utils.read with range reads subset', async () => {
    await writeFile(join(tmpDir, 'ranged.txt'), 'l1\nl2\nl3\nl4\nl5')
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
    })
    const content = await ctx.utils.read('ranged.txt', { start: 2, end: 4 })
    expect(content).toContain('l2')
    expect(content).toContain('l3')
    expect(content).not.toContain('l5')
  })

  it('utils.splitByDirectory splits subdirectories', async () => {
    await mkdir(join(tmpDir, 'modA'), { recursive: true })
    await mkdir(join(tmpDir, 'modB'), { recursive: true })
    await writeFile(join(tmpDir, 'modA', 'a.ts'), 'x')
    await writeFile(join(tmpDir, 'modB', 'b.ts'), 'y')
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
    })
    const modules = await ctx.utils.splitByDirectory(tmpDir, { depth: 1 })
    const names = modules.map((m) => m.name)
    expect(names).toContain('modA')
    expect(names).toContain('modB')
  })

  it('utils.grep finds matching lines', async () => {
    await writeFile(join(tmpDir, 'search.ts'), 'const hello = "world"\nconst foo = "bar"')
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
    })
    const results = await ctx.utils.grep('hello')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]?.text).toContain('hello')
  })
})
