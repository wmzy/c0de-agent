import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '../../shared/types/tool.js'
import { grepTool } from './grep.js'

let workDir: string
let ctx: ToolContext

beforeEach(async () => {
  workDir = join(tmpdir(), `grep-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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


describe('grepTool', () => {
  it('finds matching lines', async () => {
    await writeFile(join(workDir, 'a.ts'), 'const foo = 1\nconst bar = 2\nfoo()\n')
    const result = await grepTool.execute({ pattern: 'foo' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('a.ts')
      expect(result.output).toContain('const foo = 1')
      expect(result.output).toContain('foo()')
    }
  })

  it('supports regex patterns', async () => {
    await writeFile(join(workDir, 'a.ts'), 'const x123 = 1\nconst abc = 2\n')
    const result = await grepTool.execute({ pattern: 'x\\d+' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('x123')
      expect(result.output).not.toContain('abc')
    }
  })

  it('case insensitive search', async () => {
    await writeFile(join(workDir, 'a.ts'), 'const Hello = 1\nconst world = 2\n')
    const result = await grepTool.execute({ pattern: 'hello', caseSensitive: false }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('Hello')
    }
  })

  it('searches across multiple files', async () => {
    await mkdir(join(workDir, 'src'), { recursive: true })
    await writeFile(join(workDir, 'a.ts'), 'target line\n')
    await writeFile(join(workDir, 'src', 'b.ts'), 'another target\n')
    await writeFile(join(workDir, 'c.md'), 'nothing here\n')
    const result = await grepTool.execute({ pattern: 'target' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('a.ts')
      expect(result.output).toContain('src/b.ts')
      expect(result.output).not.toContain('c.md')
    }
  })

  it('respects maxResults', async () => {
    await writeFile(join(workDir, 'a.ts'), 'match\nmatch\nmatch\nmatch\nmatch\n')
    const result = await grepTool.execute({ pattern: 'match', maxResults: 2 }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      const lines = result.output.split('\n').filter((l) => l.includes('match'))
      expect(lines.length).toBe(2)
    }
  })

  it('returns empty for no matches', async () => {
    await writeFile(join(workDir, 'a.ts'), 'nothing\n')
    const result = await grepTool.execute({ pattern: 'xyz123' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output.trim()).toBe('')
    }
  })

  it('returns error for invalid regex', async () => {
    const result = await grepTool.execute({ pattern: '[' }, ctx)
    expect(result._tag).toBe('error')
  })

  it('has correct tool definition', () => {
    expect(grepTool.name).toBe('grep')
    expect(grepTool.permission).toBe('auto')
  })
})
