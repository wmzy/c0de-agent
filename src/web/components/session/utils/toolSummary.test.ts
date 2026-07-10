import { describe, expect, it } from 'vitest'
import { toolSummary } from './toolSummary.js'

describe('toolSummary', () => {
  it('read/write/edit 取 path', () => {
    expect(toolSummary('read', { path: 'a.ts' })).toBe('a.ts')
    expect(toolSummary('write', { path: 'b.ts' })).toBe('b.ts')
    expect(toolSummary('edit', { path: 'c.ts' })).toBe('c.ts')
  })

  it('bash 取命令首行并加 $ 前缀', () => {
    expect(toolSummary('bash', { command: 'pnpm test' })).toBe('$ pnpm test')
  })

  it('bash 多行命令只取首行', () => {
    expect(toolSummary('bash', { command: 'echo a\necho b' })).toBe('$ echo a')
  })

  it('bash 超长命令截断为 60 字符 + …', () => {
    const long = 'x'.repeat(120)
    const out = toolSummary('bash', { command: long })
    expect(out).toBe(`$ ${'x'.repeat(60)}…`)
    expect(out.length).toBe(63)
  })

  it('grep 取 pattern 并加引号', () => {
    expect(toolSummary('grep', { pattern: 'foo' })).toBe('"foo"')
  })

  it('glob 取 pattern', () => {
    expect(toolSummary('glob', { pattern: '*.ts' })).toBe('*.ts')
  })

  it('未知工具取首个字符串标量值', () => {
    expect(toolSummary('custom', { n: 1, name: 'hello', x: 2 })).toBe('hello')
  })

  it('input 为空或无字符串值时返回空串', () => {
    expect(toolSummary('read', {})).toBe('')
    expect(toolSummary('custom', { n: 1 })).toBe('')
    expect(toolSummary('custom', null)).toBe('')
  })

  it('task 批量模式显示 agent 数量', () => {
    expect(
      toolSummary('task', {
        subagent_type: 'coder',
        context: 'shared',
        tasks: [{ assignment: 'a' }, { assignment: 'b' }],
      }),
    ).toBe('coder × 2 agents')
  })

  it('task 单任务模式显示 type + description', () => {
    expect(
      toolSummary('task', {
        subagent_type: 'researcher',
        prompt: 'investigate the auth flow',
        description: 'Auth investigation',
      }),
    ).toBe('researcher · Auth investigation')
  })

  it('task 单任务无 description 时显示 prompt 摘要', () => {
    expect(
      toolSummary('task', {
        subagent_type: 'coder',
        prompt: 'Fix the login bug in auth.ts',
      }),
    ).toBe('coder · Fix the login bug in auth.ts')
  })
})
