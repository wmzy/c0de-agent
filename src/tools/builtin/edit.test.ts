import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolContext } from '../../shared/types/tool.js'
import { editTool } from './edit.js'

let workDir: string
let ctx: ToolContext

beforeEach(async () => {
  workDir = join(tmpdir(), `edit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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

describe('editTool', () => {
  it('replaces exact text', async () => {
    await writeFile(join(workDir, 'f.ts'), 'const x = 1\nconst y = 2\n')
    const result = await editTool.execute(
      { path: 'f.ts', oldText: 'const x = 1', newText: 'const x = 42' },
      ctx,
    )
    expect(result._tag).toBe('success')
    const content = await readFile(join(workDir, 'f.ts'), 'utf-8')
    expect(content).toBe('const x = 42\nconst y = 2\n')
  })

  it('replaces multiline text', async () => {
    await writeFile(join(workDir, 'f.ts'), 'function foo() {\n  return 1\n}\n')
    const result = await editTool.execute(
      {
        path: 'f.ts',
        oldText: 'function foo() {\n  return 1\n}',
        newText: 'function foo() {\n  return 42\n}',
      },
      ctx,
    )
    expect(result._tag).toBe('success')
    const content = await readFile(join(workDir, 'f.ts'), 'utf-8')
    expect(content).toContain('return 42')
  })

  it('returns error when oldText not found', async () => {
    await writeFile(join(workDir, 'f.ts'), 'hello world\n')
    const result = await editTool.execute(
      { path: 'f.ts', oldText: 'nonexistent', newText: 'x' },
      ctx,
    )
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('not found')
    }
  })

  it('returns error when oldText matches multiple times', async () => {
    await writeFile(join(workDir, 'f.ts'), 'dup\ndup\n')
    const result = await editTool.execute({ path: 'f.ts', oldText: 'dup', newText: 'unique' }, ctx)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('multiple')
    }
  })

  it('fuzzy matches with different whitespace', async () => {
    await writeFile(join(workDir, 'f.ts'), 'const x = 1\nconst y = 2\n')
    // oldText has extra spaces — should still match via fuzzy whitespace
    const result = await editTool.execute(
      { path: 'f.ts', oldText: 'const  x  =  1', newText: 'const x = 42' },
      ctx,
    )
    expect(result._tag).toBe('success')
  })

  it('returns error for non-existent file', async () => {
    const result = await editTool.execute({ path: 'nope.ts', oldText: 'a', newText: 'b' }, ctx)
    expect(result._tag).toBe('error')
  })

  it('has correct tool definition', () => {
    expect(editTool.name).toBe('edit')
    expect(editTool.permission).toBe('ask')
    expect(editTool.parameters.required).toEqual(['path', 'oldText', 'newText'])
  })
})
