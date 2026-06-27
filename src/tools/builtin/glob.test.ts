import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolContext } from '../../shared/types/tool.js'
import { globTool, globToRegex } from './glob.js'

let workDir: string
let ctx: ToolContext

beforeEach(async () => {
  workDir = join(tmpdir(), `glob-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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

async function setupFiles() {
  await mkdir(join(workDir, 'src'), { recursive: true })
  await mkdir(join(workDir, 'src', 'utils'), { recursive: true })
  await mkdir(join(workDir, 'node_modules'), { recursive: true })
  await mkdir(join(workDir, '.git'), { recursive: true })
  await writeFile(join(workDir, 'src', 'a.ts'), 'x')
  await writeFile(join(workDir, 'src', 'b.ts'), 'x')
  await writeFile(join(workDir, 'src', 'c.js'), 'x')
  await writeFile(join(workDir, 'src', 'utils', 'd.ts'), 'x')
  await writeFile(join(workDir, 'readme.md'), 'x')
  await writeFile(join(workDir, 'node_modules', 'dep.js'), 'x')
  await writeFile(join(workDir, '.git', 'config'), 'x')
}

describe('globToRegex', () => {
  it('matches simple wildcard', () => {
    const re = globToRegex('*.ts')
    expect(re.test('foo.ts')).toBe(true)
    expect(re.test('foo.js')).toBe(false)
  })

  it('matches double-star across directories', () => {
    const re = globToRegex('src/**/*.ts')
    expect(re.test('src/a.ts')).toBe(true)
    expect(re.test('src/utils/d.ts')).toBe(true)
    expect(re.test('src/utils/sub/e.ts')).toBe(true)
    expect(re.test('src/a.js')).toBe(false)
  })

  it('matches brace expansion', () => {
    const re = globToRegex('*.{ts,js}')
    expect(re.test('a.ts')).toBe(true)
    expect(re.test('a.js')).toBe(true)
    expect(re.test('a.md')).toBe(false)
  })

  it('matches question mark', () => {
    const re = globToRegex('?.ts')
    expect(re.test('a.ts')).toBe(true)
    expect(re.test('ab.ts')).toBe(false)
  })
})

describe('globTool', () => {
  it('finds files matching pattern', async () => {
    await setupFiles()
    const result = await globTool.execute({ pattern: 'src/**/*.ts' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('a.ts')
      expect(result.output).toContain('b.ts')
      expect(result.output).toContain('utils/d.ts')
      expect(result.output).not.toContain('c.js')
    }
  })

  it('finds files in root', async () => {
    await setupFiles()
    const result = await globTool.execute({ pattern: '*.md' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('readme.md')
    }
  })

  it('finds multiple extensions', async () => {
    await setupFiles()
    const result = await globTool.execute({ pattern: 'src/*.{ts,js}' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('a.ts')
      expect(result.output).toContain('c.js')
    }
  })

  it('ignores node_modules and .git', async () => {
    await setupFiles()
    const result = await globTool.execute({ pattern: '**/*' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).not.toContain('node_modules')
      expect(result.output).not.toContain('.git')
    }
  })

  it('returns empty result for no matches', async () => {
    await setupFiles()
    const result = await globTool.execute({ pattern: '**/*.xyz' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output.trim()).toBe('')
    }
  })

  it('has correct tool definition', () => {
    expect(globTool.name).toBe('glob')
    expect(globTool.permission).toBe('auto')
  })
})
