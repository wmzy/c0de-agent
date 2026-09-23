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

  // 回归：空 oldText 让 indexOf('') 恒返回 0、searchFrom 永不前进——matches
  // 数组推到 2^32 溢出（RangeError: Invalid array length）前烧数秒 CPU，
  // 且报错信息误导模型原样重试。修复后应快速返回指向「空 oldText」的错误。
  it('rejects empty oldText with a clear error without churning', async () => {
    await writeFile(join(workDir, 'f.ts'), 'hello world\n')
    const started = Date.now()
    const result = await editTool.execute({ path: 'f.ts', oldText: '', newText: 'x' }, ctx)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('empty')
    }
    const content = await readFile(join(workDir, 'f.ts'), 'utf-8')
    expect(content).toBe('hello world\n')
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

  // 回归：CRLF 文件的 \r 对模型不可见——模型生成的 oldText 恒用 \n。
  // normalize 只折叠 [ \t]，\r\n 原样保留：\n 版 oldText 在 CRLF 文件上
  // indexOf 恒 -1，报「oldText not found」，任何 CRLF 文件都无法 diff 编辑。
  it('matches CRLF files with LF oldText and preserves CRLF line endings', async () => {
    await writeFile(join(workDir, 'f.ts'), 'const a = 1;\r\nconst b = 2;\r\n', 'utf-8')
    const result = await editTool.execute(
      { path: 'f.ts', oldText: 'const a = 1;', newText: 'const a = 42;' },
      ctx,
    )
    expect(result._tag).toBe('success')
    // 单行替换：被替换行不含换行，文件其余 CRLF 行尾原样保留
    expect(await readFile(join(workDir, 'f.ts'), 'utf-8')).toBe('const a = 42;\r\nconst b = 2;\r\n')
  })

  // 回归：多行替换时被替换区域内的行尾必须跟随文件主导行尾（CRLF），
  // 否则产出 CRLF/LF 混合行尾（git diff 全行噪音 + 换行风格损坏）。
  it('keeps CRLF inside a multiline replaced region', async () => {
    await writeFile(join(workDir, 'f.ts'), 'line1\r\nline2\r\nline3\r\n', 'utf-8')
    const result = await editTool.execute(
      {
        path: 'f.ts',
        oldText: 'line1\nline2',
        newText: 'alpha\nbeta',
      },
      ctx,
    )
    expect(result._tag).toBe('success')
    expect(await readFile(join(workDir, 'f.ts'), 'utf-8')).toBe('alpha\r\nbeta\r\nline3\r\n')
  })

  // 回归：行尾判定若只看**被替换区域**是否含 CRLF，则「单行区域 + 多行 newText」
  // 漏判——区域本身不含换行（region.includes('\r\n') 为假），newText 的 \n 原样
  // 写入 CRLF 文件，产出混合行尾（git diff 全行噪音 + 换行风格损坏）。
  // 口径与 hashline 模式/grep/shake 一致：按文件主导行尾（content.includes('\r\n')）判定。
  it('keeps file line endings when a single-line region is replaced by multiline text', async () => {
    await writeFile(join(workDir, 'f.ts'), 'line1\r\nline2\r\nline3\r\n', 'utf-8')
    const result = await editTool.execute(
      { path: 'f.ts', oldText: 'line2', newText: 'alpha\nbeta' },
      ctx,
    )
    expect(result._tag).toBe('success')
    const after = await readFile(join(workDir, 'f.ts'), 'utf-8')
    expect(after).toBe('line1\r\nalpha\r\nbeta\r\nline3\r\n')
    expect(after).not.toMatch(/[^\r]\n/)
  })

  // LF 文件（主导行尾 \n）不受影响：单行区域替换为多行文本仍保持 LF。
  it('keeps LF line endings for LF files', async () => {
    await writeFile(join(workDir, 'f.ts'), 'line1\nline2\nline3\n', 'utf-8')
    await editTool.execute({ path: 'f.ts', oldText: 'line2', newText: 'alpha\nbeta' }, ctx)
    expect(await readFile(join(workDir, 'f.ts'), 'utf-8')).toBe('line1\nalpha\nbeta\nline3\n')
  })

  // 回归：归一化只在文件为 CRLF 时生效——LF 文件 + CRLF newText（模型粘贴
  // Windows 文本）时 \r\n 原样写入，与其余行混成 CRLF/LF 混合行尾
  //（与 hashline 模式的单向剥离同型）。
  it('normalizes CRLF newText into LF files', async () => {
    await writeFile(join(workDir, 'f.ts'), 'line1\nline2\nline3\n', 'utf-8')
    const result = await editTool.execute(
      { path: 'f.ts', oldText: 'line2', newText: 'alpha\r\nbeta' },
      ctx,
    )
    expect(result._tag).toBe('success')
    const after = await readFile(join(workDir, 'f.ts'), 'utf-8')
    expect(after).toBe('line1\nalpha\nbeta\nline3\n')
    expect(after).not.toMatch(/\r\n/)
  })

  // 回归：匹配区域以换行开头时，映射起点落在 CRLF 对的 \n 上（normalize 把
  // \r\n 折成 \n，映射按「\r 是原文多余空白」只前进原文指针）——区域外的
  // 前一行 \r 留在原地，而 replacement 又自带 \r\n，拼成「\r\r\n」：文件凭空
  // 多出孤立回车（行尾损坏 + git diff 全行噪音），且原行尾被吃掉。
  // 与末尾守卫对称：起点落在 CRLF 对中间时把 \r 纳入区域。
  it('does not leave a stray CR when the matched region starts at a line break', async () => {
    await writeFile(join(workDir, 'f.ts'), 'line1\r\nline2\r\nline3\r\n', 'utf-8')
    const result = await editTool.execute(
      { path: 'f.ts', oldText: '\nline2', newText: '\nLINE2' },
      ctx,
    )
    expect(result._tag).toBe('success')
    const after = await readFile(join(workDir, 'f.ts'), 'utf-8')
    expect(after).toBe('line1\r\nLINE2\r\nline3\r\n')
    expect(after).not.toMatch(/\r\r/)
  })

  // 同型：区域起点落在换行上、替换文本不含换行时，残留 \r 同样污染行尾
  //（"line1\r" + "X" → "line1\rX"）。
  it('does not leave a stray CR when a line-break-anchored region shrinks to one line', async () => {
    await writeFile(join(workDir, 'f.ts'), 'line1\r\nline2\r\nline3\r\n', 'utf-8')
    const result = await editTool.execute({ path: 'f.ts', oldText: '\nline2', newText: 'X' }, ctx)
    expect(result._tag).toBe('success')
    const after = await readFile(join(workDir, 'f.ts'), 'utf-8')
    expect(after).toBe('line1X\r\nline3\r\n')
    expect(after).not.toMatch(/\r[^\n]/)
  })

  it('returns error for non-existent file', async () => {
    const result = await editTool.execute({ path: 'nope.ts', oldText: 'a', newText: 'b' }, ctx)
    expect(result._tag).toBe('error')
  })

  it('rejects a relative path that escapes the working directory', async () => {
    const result = await editTool.execute(
      { path: '../escape.txt', oldText: 'a', newText: 'b' },
      ctx,
    )
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('escapes the working directory')
    }
  })

  it('rejects an absolute path outside the working directory', async () => {
    const result = await editTool.execute({ path: '/etc/passwd', oldText: 'a', newText: 'b' }, ctx)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('escapes the working directory')
    }
  })

  it('has correct tool definition', () => {
    expect(editTool.name).toBe('edit')
    expect(editTool.permission).toBe('ask')
    expect(editTool.parameters.required).toEqual(['path'])
  })
})

describe('editTool (hashline mode)', () => {
  it('applies a hashline patch when hash matches', async () => {
    const { computeHash } = await import('../hashline/index.js')
    const content = 'line1\nline2\nline3\n'
    await writeFile(join(workDir, 'f.ts'), content)
    const hash = computeHash(content)
    const patch = `[f.ts#${hash}]\nSWAP 2-2\nREPLACED\n---\n`
    const result = await editTool.execute({ path: 'f.ts', patch }, ctx)
    expect(result._tag).toBe('success')
    const out = await readFile(join(workDir, 'f.ts'), 'utf-8')
    expect(out).toBe('line1\nREPLACED\nline3\n')
  })

  it('rejects a stale hash (file changed) without modifying file', async () => {
    await writeFile(join(workDir, 'f.ts'), 'current\n')
    const result = await editTool.execute(
      { path: 'f.ts', patch: '[f.ts#ffff]\nSWAP 1-1\nx\n---\n' },
      ctx,
    )
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('hash mismatch')
    }
    expect(await readFile(join(workDir, 'f.ts'), 'utf-8')).toBe('current\n')
  })

  it('rejects out-of-bounds line range without modifying file', async () => {
    const { computeHash } = await import('../hashline/index.js')
    const content = 'only\n'
    await writeFile(join(workDir, 'f.ts'), content)
    const hash = computeHash(content)
    const patch = `[f.ts#${hash}]\nSWAP 9-9\nx\n---\n`
    const result = await editTool.execute({ path: 'f.ts', patch }, ctx)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('out of bounds')
    }
    expect(await readFile(join(workDir, 'f.ts'), 'utf-8')).toBe('only\n')
  })

  it('returns error when neither mode params provided', async () => {
    await writeFile(join(workDir, 'f.ts'), 'x\n')
    const result = await editTool.execute({ path: 'f.ts' } as never, ctx)
    expect(result._tag).toBe('error')
  })
})
