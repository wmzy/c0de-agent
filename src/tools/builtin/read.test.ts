import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolContext } from '../../shared/types/tool.js'
import { createURLRegistry, registerURLResolver } from '../resolver.js'
import { readTool } from './read.js'

let workDir: string
let ctx: ToolContext

beforeEach(async () => {
  workDir = join(tmpdir(), `read-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(workDir, { recursive: true })
  ctx = {
    cwd: workDir,
    session: { id: 's1', cwd: workDir },
    abort: new AbortController().signal,
  }
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe('readTool', () => {
  it('reads a file fully', async () => {
    await writeFile(join(workDir, 'test.txt'), 'line1\nline2\nline3')
    const result = await readTool.execute({ path: 'test.txt' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('line1')
      expect(result.output).toContain('line3')
    }
  })

  it('reads with offset', async () => {
    await writeFile(join(workDir, 'test.txt'), 'line1\nline2\nline3\nline4\nline5')
    const result = await readTool.execute({ path: 'test.txt', offset: 2 }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).not.toContain('line1')
      expect(result.output).toContain('line2')
    }
  })

  it('reads with limit', async () => {
    await writeFile(join(workDir, 'test.txt'), 'line1\nline2\nline3\nline4\nline5')
    const result = await readTool.execute({ path: 'test.txt', offset: 1, limit: 2 }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('line1')
      expect(result.output).toContain('line2')
      expect(result.output).not.toContain('line3')
    }
  })

  // 回归：offset 为 1-indexed，(offset ?? 1) - 1 使 offset=0/负数产生负 slice
  // 起点——offset=0 静默返回「最后一行」而非全文件/报错，模型读到错误内容后
  // 会基于它继续推理；负数 offset/limit 同样切片错位。显式报错供模型自纠。
  it('rejects offset < 1 instead of silently returning the wrong lines', async () => {
    await writeFile(join(workDir, 'test.txt'), 'line1\nline2\nline3\nline4\nline5')
    const zero = await readTool.execute({ path: 'test.txt', offset: 0 }, ctx)
    expect(zero._tag).toBe('error')
    if (zero._tag === 'error') {
      expect(zero.error).toContain('offset')
    }
    const neg = await readTool.execute({ path: 'test.txt', offset: -1 }, ctx)
    expect(neg._tag).toBe('error')
  })

  it('rejects a negative limit instead of silently mis-slicing', async () => {
    await writeFile(join(workDir, 'test.txt'), 'line1\nline2\nline3\nline4\nline5')
    const result = await readTool.execute({ path: 'test.txt', offset: 2, limit: -3 }, ctx)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('limit')
    }
  })

  // 回归（同型扩展）：JSON 可表示 Infinity（模型输出 1e999 → JSON.parse 得到
  // Infinity）与小数——slice 对非整数的处理是静默截断/错位：offset=Infinity
  // 返回空串、offset=2.5 被截成 2 静默错行、limit=1e999 语义失效。显式报错。
  it('rejects a fractional offset instead of silently shifting lines', async () => {
    await writeFile(join(workDir, 'test.txt'), 'line1\nline2\nline3\nline4\nline5')
    const result = await readTool.execute({ path: 'test.txt', offset: 2.5 }, ctx)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('offset')
    }
  })

  it('rejects Infinity offset/limit instead of silently returning the wrong slice', async () => {
    await writeFile(join(workDir, 'test.txt'), 'line1\nline2\nline3\nline4\nline5')
    // JSON 里模型可写 1e999，JSON.parse 后即 Number.POSITIVE_INFINITY。
    const off = await readTool.execute({ path: 'test.txt', offset: Number.POSITIVE_INFINITY }, ctx)
    expect(off._tag).toBe('error')
    if (off._tag === 'error') {
      expect(off.error).toContain('offset')
    }
    const lim = await readTool.execute(
      { path: 'test.txt', offset: 1, limit: Number.POSITIVE_INFINITY },
      ctx,
    )
    expect(lim._tag).toBe('error')
    if (lim._tag === 'error') {
      expect(lim.error).toContain('limit')
    }
  })

  it('returns error for non-existent file', async () => {
    const result = await readTool.execute({ path: 'nope.txt' }, ctx)
    expect(result._tag).toBe('error')
  })

  it('reads from absolute path', async () => {
    const abs = join(workDir, 'abs.txt')
    await writeFile(abs, 'absolute')
    const result = await readTool.execute({ path: abs }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toBe('absolute')
    }
  })

  it('lists a directory with trailing slash on subdirectories', async () => {
    await writeFile(join(workDir, 'a.txt'), 'x')
    await mkdir(join(workDir, 'sub'))
    const result = await readTool.execute({ path: '.' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('a.txt')
      expect(result.output).toContain('sub/')
      expect(result.output).not.toMatch(/(^|\n)a\.txt\/$/) // files must not get a slash
    }
  })

  it('lists an empty directory without erroring', async () => {
    await mkdir(join(workDir, 'empty'))
    const result = await readTool.execute({ path: 'empty' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      // 空目录必须返回成功且不含 EISDIR,而非抛目录读取错误
      expect(result.output).not.toContain('EISDIR')
    }
  })

  it('rejects a relative path that escapes the working directory', async () => {
    const result = await readTool.execute({ path: '../../../etc/passwd' }, ctx)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('escapes the working directory')
    }
  })

  it('rejects an absolute path outside the working directory', async () => {
    const result = await readTool.execute({ path: '/etc/passwd' }, ctx)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('escapes the working directory')
    }
  })

  it('has correct tool definition', () => {
    expect(readTool.name).toBe('read')
    expect(readTool.permission).toBe('auto')
    expect(readTool.parameters.type).toBe('object')
    expect(readTool.parameters.required).toContain('path')
  })

  // ===== 内部 URL scheme 支持（spec §3.10）=====

  it('resolves skill:// URL via the registry and returns resolved content', async () => {
    const reg = createURLRegistry()
    registerURLResolver(reg, {
      scheme: 'skill',
      resolve: async () => '# Skill\nbrainstorming steps',
    })
    const urlCtx: ToolContext = { ...ctx, urlRegistry: reg }
    const result = await readTool.execute({ path: 'skill://brainstorming' }, urlCtx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') expect(result.output).toContain('brainstorming steps')
  })

  it('applies offset/limit to resolved URL content', async () => {
    const reg = createURLRegistry()
    registerURLResolver(reg, {
      scheme: 'agent',
      resolve: async () => 'l1\nl2\nl3\nl4',
    })
    const urlCtx: ToolContext = { ...ctx, urlRegistry: reg }
    const result = await readTool.execute({ path: 'agent://Task1', offset: 2, limit: 2 }, urlCtx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('l2')
      expect(result.output).toContain('l3')
      expect(result.output).not.toContain('l1')
      expect(result.output).not.toContain('l4')
    }
  })

  it('returns error for URL when no registry is wired', async () => {
    const result = await readTool.execute({ path: 'skill://x' }, ctx)
    expect(result._tag).toBe('error')
  })

  it('returns error for unregistered scheme', async () => {
    const reg = createURLRegistry()
    const urlCtx: ToolContext = { ...ctx, urlRegistry: reg }
    const result = await readTool.execute({ path: 'unknown://x' }, urlCtx)
    expect(result._tag).toBe('error')
  })

  // ===== 冲突标记检测（conflict:// 注册 + footer）=====

  it('appends a conflict footer listing registered conflicts for a conflicted file', async () => {
    // 独立会话 id：conflict id 是会话级计数，避免与其他用例的注册互相串
    const conflictCtx: ToolContext = {
      ...ctx,
      session: { id: 'read-conflict-1', cwd: workDir },
    }
    await writeFile(
      join(workDir, 'merged.txt'),
      [
        'intro',
        '<<<<<<< HEAD',
        'ours line',
        '=======',
        'theirs line',
        '>>>>>>> feature/x',
        'outro',
      ].join('\n'),
    )
    const result = await readTool.execute({ path: 'merged.txt' }, conflictCtx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      // 正文原样 + 尾部 footer：数量、id 与行号区间、用法提示
      expect(result.output).toContain('<<<<<<< HEAD')
      expect(result.output).toContain('[conflict] file has 1 unresolved conflict(s): #1 (L2-L6)')
      expect(result.output).toContain('ours = HEAD, theirs = feature/x')
      expect(result.output).toContain('read conflict://<id>')
      expect(result.output).toContain('write conflict://<id>')
    }
  })

  it('leaves clean files without a conflict footer', async () => {
    await writeFile(join(workDir, 'clean.txt'), 'a\nb\nc')
    const result = await readTool.execute({ path: 'clean.txt' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') expect(result.output).not.toContain('[conflict]')
  })

  it('registers all conflicts with absolute line numbers even on a ranged read', async () => {
    const conflictCtx: ToolContext = {
      ...ctx,
      session: { id: 'read-conflict-2', cwd: workDir },
    }
    await writeFile(
      join(workDir, 'two.txt'),
      [
        'x',
        '<<<<<<< A',
        'o1',
        '=======',
        't1',
        '>>>>>>> A',
        'mid',
        '<<<<<<< B',
        'o2',
        '=======',
        't2',
        '>>>>>>> B',
      ].join('\n'),
    )
    // 窗口只覆盖第二块；扫描注册的是整个文件（read 本就整读），footer 两个 id 都在
    const result = await readTool.execute({ path: 'two.txt', offset: 8, limit: 5 }, conflictCtx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain(
        '[conflict] file has 2 unresolved conflict(s): #1 (L2-L6), #2 (L8-L12)',
      )
    }
  })

  it('does not mistake indented marker lookalikes for conflicts', async () => {
    await writeFile(
      join(workDir, 'lookalike.txt'),
      ['  <<<<<<< HEAD', '\t=======', ' >>>>>>> b', 'plain'].join('\n'),
    )
    const result = await readTool.execute({ path: 'lookalike.txt' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') expect(result.output).not.toContain('[conflict]')
  })
})
