import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolContext } from '../../shared/types/tool.js'
import { globTool, globToRegex } from './glob.js'

let workDir: string
let ctx: ToolContext
const outsideDirs: string[] = []

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
  for (const dir of outsideDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
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

  // 回归：花括号分支此前经 escapeRegex 转义——分支内的通配符被当作字面量，
  // `{*.spec.ts,*.test.ts}` 转成 ^(?:\*\.spec\.ts|\*\.test\.ts)$ 恒不匹配，
  // 模型静默拿到「零测试文件」的错误结论。
  it('treats wildcards inside brace alternatives as wildcards', () => {
    const re = globToRegex('{*.spec.ts,*.test.ts}')
    expect(re.test('foo.test.ts')).toBe(true)
    expect(re.test('foo.spec.ts')).toBe(true)
    expect(re.test('foo.ts')).toBe(false)
  })

  it('supports question mark inside brace alternatives', () => {
    const re = globToRegex('file-{a?,b}')
    expect(re.test('file-ab')).toBe(true)
    expect(re.test('file-b')).toBe(true)
    expect(re.test('file-abc')).toBe(false)
  })

  // 字符类取反：glob 标准语法 [!...] 意为「类内字符除外」。此前首字符 ! 被当作
  // 字面量直接拼进正则，[!0-9] 语义反转为「! 或数字」——静默匹配应排除的文件、
  // 漏掉应命中的文件。
  it('treats [!...] as negated character class', () => {
    const re = globToRegex('src/*[!0-9].ts')
    expect(re.test('src/a.ts')).toBe(true)
    expect(re.test('src/a0.ts')).toBe(false)
    expect(re.test('src/0.ts')).toBe(false)
  })

  // 字面 ^（bash 口径 ^ 无取反义）：此前裸透传进正则被 JS 解释为取反。
  it('treats leading ^ in class as literal (bash semantics)', () => {
    const re = globToRegex('src/[^a].ts')
    expect(re.test('src/^.ts')).toBe(true)
    expect(re.test('src/a.ts')).toBe(true)
    expect(re.test('src/b.ts')).toBe(false)
  })

  // 非法/退化字符类此前让 new RegExp 抛 SyntaxError 击穿工具调用；
  // 应降级为字面量匹配，绝不抛出。
  it('never throws on degenerate char classes', () => {
    const empty = globToRegex('[]')
    expect(empty.test('[]')).toBe(true)
    expect(empty.test('a')).toBe(false)
    const reversed = globToRegex('[z-a].ts')
    expect(reversed.test('[z-a].ts')).toBe(true)
    expect(reversed.test('b.ts')).toBe(false)
    // 类首 ] 是字面量成员（bash 口径）
    const bracketMember = globToRegex('[]a]')
    expect(bracketMember.test(']')).toBe(true)
    expect(bracketMember.test('a')).toBe(true)
    expect(bracketMember.test('b')).toBe(false)
  })

  // [!] 若按「取反后空类」翻译会退化为匹配任意字符（正则 [^] = 一切）；
  // 应保持字面量 !。
  it('keeps lone [!] literal', () => {
    const re = globToRegex('[!]')
    expect(re.test('!')).toBe(true)
    expect(re.test('a')).toBe(false)
  })

  // 空花括号分支此前生成 (?:a|) 正则——空分支匹配空串，模式命中一切文件。
  it('treats brace with empty alternative as literal', () => {
    const re = globToRegex('{a,}.ts')
    expect(re.test('{a,}.ts')).toBe(true)
    expect(re.test('a.ts')).toBe(false)
    expect(re.test('.ts')).toBe(false)
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

  // 回归：path 参数此前未过 safeResolve（read/write/edit 同口径），绝对路径或
  // ../ 可逃逸 cwd——permission:auto 下静默枚举工作目录外文件（如 ~/.ssh）。
  it('rejects a relative path that escapes the working directory', async () => {
    const outside = join(
      tmpdir(),
      `glob-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    outsideDirs.push(outside)
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'x')
    const result = await globTool.execute(
      { pattern: '**/*', path: join('..', outside.split('/').pop() ?? '') },
      ctx,
    )
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('escapes the working directory')
    }
  })

  it('rejects an absolute path outside the working directory', async () => {
    const outside = join(
      tmpdir(),
      `glob-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    outsideDirs.push(outside)
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'x')
    const result = await globTool.execute({ pattern: '**/*', path: outside }, ctx)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('escapes the working directory')
    }
  })
})
