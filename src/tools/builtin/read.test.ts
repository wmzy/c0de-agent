import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolContext } from '../../shared/types/tool.js'
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

  it('has correct tool definition', () => {
    expect(readTool.name).toBe('read')
    expect(readTool.permission).toBe('auto')
    expect(readTool.parameters.type).toBe('object')
    expect(readTool.parameters.required).toContain('path')
  })
})
