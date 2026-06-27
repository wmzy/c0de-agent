import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '../../shared/types/tool.js'
import { writeTool } from './write.js'

let workDir: string
let ctx: ToolContext

beforeEach(async () => {
  workDir = join(tmpdir(), `write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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

describe('writeTool', () => {
  it('creates a new file', async () => {
    const result = await writeTool.execute({ path: 'new.txt', content: 'hello world' }, ctx)
    expect(result._tag).toBe('success')
    const written = await readFile(join(workDir, 'new.txt'), 'utf-8')
    expect(written).toBe('hello world')
  })

  it('overwrites an existing file', async () => {
    await writeTool.execute({ path: 'file.txt', content: 'old' }, ctx)
    await writeTool.execute({ path: 'file.txt', content: 'new' }, ctx)
    const written = await readFile(join(workDir, 'file.txt'), 'utf-8')
    expect(written).toBe('new')
  })

  it('creates parent directories', async () => {
    const result = await writeTool.execute(
      { path: 'sub/dir/file.txt', content: 'nested' },
      ctx,
    )
    expect(result._tag).toBe('success')
    const written = await readFile(join(workDir, 'sub/dir/file.txt'), 'utf-8')
    expect(written).toBe('nested')
  })

  it('writes to absolute path', async () => {
    const abs = join(workDir, 'abs.txt')
    await writeTool.execute({ path: abs, content: 'abs' }, ctx)
    const written = await readFile(abs, 'utf-8')
    expect(written).toBe('abs')
  })

  it('returns error on permission denied', async () => {
    const result = await writeTool.execute(
      { path: '/proc/cannot-write-here', content: 'x' },
      ctx,
    )
    expect(result._tag).toBe('error')
  })

  it('has correct tool definition', () => {
    expect(writeTool.name).toBe('write')
    expect(writeTool.permission).toBe('ask')
    expect(writeTool.parameters.required).toEqual(['path', 'content'])
  })
})
