import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolContext } from '../../shared/types/tool.js'
import { grepTool } from './grep.js'

let workDir: string
let ctx: ToolContext
const outsideDirs: string[] = []

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
  for (const dir of outsideDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
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

  // 回归：walkForFiles 用 name.slice(name.lastIndexOf('.')) 取扩展名——无扩展名
  // 文件（Dockerfile/Makefile/README/LICENSE）lastIndexOf 返回 -1，slice(-1)
  // 取到名字最后一个字符而非 ''，ext === '' 分支成死代码，此类文件被静默跳过，
  // grep 报「无结果」误导模型。TEXT_EXTENSIONS 无相关条目即证明不是白名单问题。
  it('searches extensionless files (Dockerfile/Makefile/README)', async () => {
    await writeFile(join(workDir, 'Dockerfile'), 'FROM node:22\nRUN echo dockerfile-marker\n')
    await writeFile(join(workDir, 'Makefile'), 'build:\n\techo makefile-marker\n')
    await writeFile(join(workDir, 'README'), 'readme-marker line\n')
    await writeFile(join(workDir, 'a.ts'), 'unrelated\n')
    for (const marker of ['dockerfile-marker', 'makefile-marker', 'readme-marker']) {
      const result = await grepTool.execute({ pattern: marker }, ctx)
      expect(result._tag).toBe('success')
      if (result._tag === 'success') {
        expect(result.output).toContain(marker)
      }
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

  // 回归：CRLF 文件的每行经 split('\n') 仍携带尾 \r——`^...$` / `\w+$` 等
  // 锚定到行尾的正则在 \r 上匹配失败，命中行静默归零、grep 报「无结果」。
  it('CRLF 文件的 ^...$ 锚定匹配不因行尾 \\r 失败', async () => {
    await writeFile(join(workDir, 'a.ts'), 'const foo = 1\r\nconst bar = 2\r\n')
    const result = await grepTool.execute({ pattern: '^const foo = 1$' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('a.ts:1: const foo = 1')
      expect(result.output).not.toContain('a.ts:2')
    }
  })

  // 回归：maxResults <= 0 时「matches.length >= max」在首个匹配后立即成立，
  // 返回 1 条且 truncated:true——既违反「最多 0 条」语义，又误导模型结果集已满。
  // 与 read 的 offset/limit 同型：数值参数未校验 → 静默错误结果。
  it('rejects maxResults < 1 instead of returning a bogus single match', async () => {
    await writeFile(join(workDir, 'a.ts'), 'match\nmatch\nmatch\n')
    const zero = await grepTool.execute({ pattern: 'match', maxResults: 0 }, ctx)
    expect(zero._tag).toBe('error')
    if (zero._tag === 'error') {
      expect(zero.error).toContain('maxResults')
    }
    const neg = await grepTool.execute({ pattern: 'match', maxResults: -1 }, ctx)
    expect(neg._tag).toBe('error')
  })

  // 回归（同型扩展）：maxResults=1e999 → Infinity 使「matches.length >= max」
  // 恒 false，上限静默失效、返回全部结果；小数同理无上限语义。显式报错供自纠。
  it('rejects non-integer maxResults instead of silently disabling the cap', async () => {
    await writeFile(join(workDir, 'a.ts'), 'match\nmatch\nmatch\nmatch\nmatch\n')
    // JSON 里模型可写 1e999，JSON.parse 后即 Number.POSITIVE_INFINITY。
    const inf = await grepTool.execute(
      { pattern: 'match', maxResults: Number.POSITIVE_INFINITY },
      ctx,
    )
    expect(inf._tag).toBe('error')
    if (inf._tag === 'error') {
      expect(inf.error).toContain('maxResults')
    }
    const frac = await grepTool.execute({ pattern: 'match', maxResults: 2.5 }, ctx)
    expect(frac._tag).toBe('error')
    if (frac._tag === 'error') {
      expect(frac.error).toContain('maxResults')
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

  // 回归：path 参数此前未过 safeResolve（read/write/edit 同口径），绝对路径或
  // ../ 可逃逸 cwd——permission:auto 下静默读取工作目录外文件内容（如 ~/.ssh）。
  it('rejects a relative path that escapes the working directory', async () => {
    const outside = join(
      tmpdir(),
      `grep-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    outsideDirs.push(outside)
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'leak.txt'), 'PRIVATE KEY MATERIAL\n')
    const result = await grepTool.execute(
      { pattern: 'PRIVATE', path: join('..', outside.split('/').pop() ?? '') },
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
      `grep-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    outsideDirs.push(outside)
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'leak.txt'), 'PRIVATE KEY MATERIAL\n')
    const result = await grepTool.execute({ pattern: 'PRIVATE', path: outside }, ctx)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('escapes the working directory')
    }
  })

  // 回归：单文件读取失败会中断整个搜索——悬空符号链接（仓库常见）或权限
  // 不可读的文件让 readFile 抛错，冒泡后整个 grep 变成 error：一个好文件都
  // 搜不到，模型误以为仓库里没有匹配。与 walkForFiles 对 readdir 失败的
  // 容错（.catch(() => null) 跳过）同口径，单文件失败应只跳过该文件。
  it('skips unreadable files instead of failing the whole search', async () => {
    await writeFile(join(workDir, 'good.ts'), 'const needle = 1\n')
    // 悬空符号链接：readFile 抛 ENOENT
    await symlink(join(workDir, 'missing-target.ts'), join(workDir, 'dangling.ts'))

    const result = await grepTool.execute({ pattern: 'needle' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('good.ts')
      expect(result.output).not.toContain('dangling.ts')
    }
  })

  // 回归：文件大小上限在 readFile 之后才判定——声明语义是「跳过 >1MB 文件」，
  // 实际先把整个文件读进内存再 skip（仓库里一个大文件就能让 grep 读取数 GB）。
  // 可观测后果：超限且不可读的文件本应按大小跳过，却因先读而 EACCES 失败。
  it('skips oversized files without reading them first', async () => {
    await writeFile(join(workDir, 'good.ts'), 'const needle = 1\n')
    const big = join(workDir, 'big.ts')
    await writeFile(big, 'x'.repeat(1024 * 1024 + 1))
    await chmod(big, 0o000) // 超限 + 不可读：修复前 readFile 先抛 EACCES

    const result = await grepTool.execute({ pattern: 'needle' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('good.ts')
      expect(result.output).not.toContain('big.ts')
    }
  })
})
