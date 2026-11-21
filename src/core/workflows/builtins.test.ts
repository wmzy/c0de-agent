import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_WORKFLOWS } from './builtins.js'
import { parseJsonArrayFromResults, parseJsonObjectsFromResults } from './context.js'
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
      // 内嵌源码经 ctx.utils 调用 JSON 提取——mock 直接挂真实实现，
      // 避免测试 mock 与生产实现漂移（正是本轮收敛的 bug 形态）。
      parseJsonArray: parseJsonArrayFromResults,
      parseJsonObjects: parseJsonObjectsFromResults,
    },
    ...overrides,
  }
}

describe('BUILTIN_WORKFLOWS', () => {
  it('has exactly 4 builtin workflows', () => {
    expect(BUILTIN_WORKFLOWS.length).toBe(4)
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

  it('review meta is correct', () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'review')
    expect(wf).toBeDefined()
    expect(wf?.meta.description).toContain('P0-P3')
    expect(wf?.meta.argsHint).toContain('--base')
  })

  it('security-audit executes and returns output', async () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'security-audit')
    const ctx = makeMockCtx({
      runSubagents: async (_type, tasks) =>
        tasks.map(() => ({ ok: true, output: JSON.stringify({ findings: [] }) })),
    })
    if (!wf) throw new Error('security-audit not found')
    const result: WorkflowResult = await wf.execute(ctx)
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
    if (!wf) throw new Error('code-review not found')
    const result = await wf.execute(ctx)
    expect(result.output).toBeDefined()
  })

  it('migration-check executes and returns output', async () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'migration-check')
    const ctx = makeMockCtx()
    if (!wf) throw new Error('migration-check not found')
    const result = await wf.execute(ctx)
    expect(result.output).toBeDefined()
  })

  it('all have sourceCode for /workflow show', () => {
    for (const wf of BUILTIN_WORKFLOWS) {
      expect(wf.sourceCode).toBeDefined()
      expect(wf.sourceCode?.length).toBeGreaterThan(0)
    }
  })
})

// ── review 工作流：真实临时 git 仓库 + mock reviewer ──────────

describe('review 工作流执行', () => {
  let repo: string

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'review-wf-'))
    const run = promisify(execFile)
    const git = (...cmd: string[]) => run('git', cmd, { cwd: repo })
    await git('init', '-q', '-b', 'main')
    await git('config', 'user.email', 't@t')
    await git('config', 'user.name', 't')
    writeFileSync(join(repo, 'base.ts'), 'export const a = 1\n'.repeat(20))
    writeFileSync(join(repo, 'package-lock.json'), '{"lock": true}')
    await git('add', '.')
    await git('commit', '-qm', 'base')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  const reviewWorkflow = () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'review')
    if (!wf) throw new Error('review workflow missing')
    return wf
  }

  const makeCtx = (
    args: string,
    findings: Array<Record<string, unknown>>,
    captured?: { assignments: string[] },
  ): WorkflowContext =>
    makeMockCtx({
      project: { rootDir: repo, name: 'test' },
      args,
      runSubagents: async (_type, tasks) => {
        if (captured) captured.assignments.push(...tasks.map((t) => t.assignment))
        return tasks.map((_, i) => ({
          ok: true,
          output: JSON.stringify({
            findings: [findings[i] ?? findings[0]],
            summary: 's',
            verdict: 'correct',
            explanation: `reviewer ${i} ok`,
          }),
        }))
      },
    })

  it('未提交变更：排除锁文件，聚合去重，P0 高把握 → BLOCK', async () => {
    writeFileSync(join(repo, 'base.ts'), 'export const a = 2\n'.repeat(20))
    writeFileSync(join(repo, 'new.ts'), 'export const b = 1\n')
    const captured: { assignments: string[] } = { assignments: [] }
    const ctx = makeCtx(
      '',
      [
        {
          severity: 'critical',
          file: 'base.ts',
          line: 3,
          issue: 'off-by-one breaks launch',
          suggestion: 'guard the index',
          priority: 0,
          confidence: 0.9,
        },
        // 同一 finding 重复（第二个 reviewer 重复报）→ 去重
        {
          severity: 'critical',
          file: 'base.ts',
          line: 3,
          issue: 'off-by-one breaks launch',
          suggestion: 'guard the index',
          priority: 0,
          confidence: 0.9,
        },
      ],
      captured,
    )
    const result: WorkflowResult = await reviewWorkflow().execute(ctx)
    expect(result.output).toContain('BLOCK')
    expect(result.output).toContain('base.ts:3')
    // 锁文件未进 reviewer 的 diff
    expect(captured.assignments.join('\n')).not.toContain('package-lock.json')
    expect(captured.assignments.join('\n')).toContain('base.ts')
    const data = result.data as { verdict: string; counts: { p0: number }; findings: unknown[] }
    expect(data.verdict).toBe('block')
    expect(data.counts.p0).toBe(1)
    expect(data.findings).toHaveLength(1)
  })

  it('无 P0 → SHIP；priority 缺省按 severity 推断', async () => {
    writeFileSync(join(repo, 'base.ts'), 'export const a = 3\n'.repeat(20))
    const ctx = makeCtx('', [
      { severity: 'warning', file: 'base.ts', line: 5, issue: 'naming drift' },
    ])
    const result = await reviewWorkflow().execute(ctx)
    expect(result.output).toContain('SHIP')
    const data = result.data as { verdict: string; counts: { p1: number } }
    expect(data.verdict).toBe('ship')
    expect(data.counts.p1).toBe(1)
  })

  it('--base <ref>：审查分支三点 diff 并携带补充要求', async () => {
    const run = promisify(execFile)
    const git = (...cmd: string[]) => run('git', cmd, { cwd: repo })
    await git('checkout', '-qb', 'feature')
    writeFileSync(join(repo, 'feature.ts'), 'export const f = 1\n'.repeat(30))
    await git('add', '.')
    await git('commit', '-qm', 'feature')
    const captured: { assignments: string[] } = { assignments: [] }
    const ctx = makeCtx('--base main 重点关注导出', [
      { severity: 'info', file: 'feature.ts', line: 1, issue: 'minor', confidence: 0.3 },
    ])
    ctx.runSubagents = async (_t, tasks) => {
      captured.assignments.push(...tasks.map((x) => x.assignment))
      return tasks.map(() => ({ ok: true, output: '{}' }))
    }
    const result = await reviewWorkflow().execute(ctx)
    expect(captured.assignments.join('\n')).toContain('feature.ts')
    expect(captured.assignments.join('\n')).toContain('重点关注导出')
    expect(result.output).toContain('SHIP')
  })

  it('只有被排除文件变更 → 明示无可审查内容', async () => {
    const run = promisify(execFile)
    const git = (...cmd: string[]) => run('git', cmd, { cwd: repo })
    writeFileSync(join(repo, 'package-lock.json'), '{"lock": true, "v": 2}')
    await git('add', '.')
    await git('commit', '-qm', 'lockonly')
    const ctx = makeCtx('', [])
    const result = await reviewWorkflow().execute(ctx)
    expect(result.output).toContain('没有可审查的文本变更')
  })

  it('工作区干净时回退审查最近一次提交', async () => {
    const captured: { assignments: string[] } = { assignments: [] }
    const ctx = makeCtx('', [
      { severity: 'info', file: 'base.ts', line: 1, issue: 'x', confidence: 0.4 },
    ])
    ctx.runSubagents = async (_t, tasks) => {
      captured.assignments.push(...tasks.map((x) => x.assignment))
      return tasks.map(() => ({
        ok: true,
        output: JSON.stringify({ findings: [], summary: 'clean', verdict: 'correct' }),
      }))
    }
    const result = await reviewWorkflow().execute(ctx)
    expect(result.output).toContain('最近一次提交')
    expect(captured.assignments.join('\n')).toContain('base.ts')
  })

  it('verdict=incorrect 的 reviewer 使整体 BLOCK（即使无 P0 finding）', async () => {
    writeFileSync(join(repo, 'base.ts'), 'export const a = 4\n'.repeat(20))
    const ctx = makeMockCtx({
      project: { rootDir: repo, name: 'test' },
      args: '',
      runSubagents: async () => [
        { ok: true, output: JSON.stringify({ findings: [], summary: 's', verdict: 'incorrect' }) },
      ],
    })
    const result = await reviewWorkflow().execute(ctx)
    expect((result.data as { verdict: string }).verdict).toBe('block')
  })
})
