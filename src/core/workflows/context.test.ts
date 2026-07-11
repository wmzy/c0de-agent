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

  it('runSubagents isolates a throwing task from its siblings (no fail-fast abort)', async () => {
    let callCount = 0
    const runSubAgentFn = vi.fn().mockImplementation(() => {
      callCount++
      // 中间任务抛异常（不是返回 error，而是 reject）
      if (callCount === 2) {
        return Promise.reject(new Error('boom'))
      }
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
      { assignment: 'task2-throws' },
      { assignment: 'task3' },
    ])
    // 1. 所有任务都有结果（未被 fail-fast 终止）
    expect(results.length).toBe(3)
    expect(runSubAgentFn).toHaveBeenCalledTimes(3)
    // 2. 抛异常的任务变为 { ok: false, error }
    expect(results[1]?.ok).toBe(false)
    if (!results[1]?.ok) {
      expect(results[1]?.error).toBe('boom')
    }
    // 3. 其余任务保持正常结果
    expect(results[0]?.ok).toBe(true)
    expect(results[2]?.ok).toBe(true)
    if (results[0]?.ok) {
      expect(results[0]?.output).toBe('result-1')
    }
    if (results[2]?.ok) {
      expect(results[2]?.output).toBe('result-3')
    }
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

  it('utils.splitByDirectory with depth=2 partitions by nested directories', async () => {
    // Structure: root/a/b/, root/a/c/, root/d/
    // depth=2 should produce modules: "a/b", "a/c", "d"
    await mkdir(join(tmpDir, 'a', 'b'), { recursive: true })
    await mkdir(join(tmpDir, 'a', 'c'), { recursive: true })
    await mkdir(join(tmpDir, 'd'), { recursive: true })
    await writeFile(join(tmpDir, 'a', 'b', 'b1.ts'), 'x')
    await mkdir(join(tmpDir, 'a', 'b', 'sub'), { recursive: true })
    await writeFile(join(tmpDir, 'a', 'b', 'sub', 'b2.ts'), 'y')
    await writeFile(join(tmpDir, 'a', 'c', 'c1.ts'), 'z')
    await writeFile(join(tmpDir, 'd', 'd1.ts'), 'w')
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
    })
    const modules = await ctx.utils.splitByDirectory(tmpDir, { depth: 2 })
    const names = modules.map((m) => m.name).sort()
    expect(names).toEqual(['a/b', 'a/c', 'd'])

    // "d" has no subdir at level 2, so it becomes a module itself
    const dMod = modules.find((m) => m.name === 'd')
    expect(dMod).toBeDefined()
    expect(dMod?.files).toEqual(['d/d1.ts'])

    // files collected recursively within each module's directory
    const abMod = modules.find((m) => m.name === 'a/b')
    expect(abMod).toBeDefined()
    expect(abMod?.files.sort()).toEqual(['a/b/b1.ts', 'a/b/sub/b2.ts'])

    const acMod = modules.find((m) => m.name === 'a/c')
    expect(acMod).toBeDefined()
    expect(acMod?.files).toEqual(['a/c/c1.ts'])
  })

  it('utils.splitByDirectory defaults to depth=1', async () => {
    await mkdir(join(tmpDir, 'x', 'y'), { recursive: true })
    await writeFile(join(tmpDir, 'x', 'x1.ts'), 'x')
    await writeFile(join(tmpDir, 'x', 'y', 'y1.ts'), 'y')
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
    })
    // no depth option -> defaults to 1: only immediate subdirectory "x"
    const modules = await ctx.utils.splitByDirectory(tmpDir)
    const names = modules.map((m) => m.name)
    expect(names).toEqual(['x'])
    // recursive collection still grabs nested files
    expect(modules[0]?.files.sort()).toEqual(['x/x1.ts', 'x/y/y1.ts'])
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
