import { describe, expect, it } from 'vitest'
import { toolSummary } from '@/components/session/utils/toolSummary.js'

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

  // 回归：clip 的 slice(0, MAX) 按 UTF-16 码元硬切——截断点落在 emoji 代理对
  // 中间时摘要带孤立代理码元，渲染为 U+FFFD 损坏显示。
  it('bash 超长命令截断不拆开代理对', () => {
    const LONE_SURROGATE_RE =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    // 59 x + 😀(2 码元) + y：截断点 60 恰好拆开代理对
    const out = toolSummary('bash', { command: `${'x'.repeat(59)}😀y` })
    expect(LONE_SURROGATE_RE.test(out)).toBe(false)
    expect(out).toBe(`$ ${'x'.repeat(59)}…`)
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
