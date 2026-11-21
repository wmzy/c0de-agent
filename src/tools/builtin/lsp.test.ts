// lsp / lsp_rename 工具测试：symbol 定位规则（词边界/子串/#N/大小写）、
// 无服务器与缺二进制错误、经假语言服务器（src/lsp/fixtures/fake-server.mjs，
// 装进工作区 node_modules/.bin/typescript-language-server）的端到端各 action、
// rename 预览/落盘。全部离线；C0DE_CONFIG_DIR 重定向隔离用户全局配置。

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultLspManager } from '../../lsp/manager.js'
import { createDefaultRegistry, listTools } from '../index.js'
import {
  applyTextEditsToString,
  findSymbolMatchIndexes,
  lspRenameTool,
  lspTool,
  parseSymbolSpec,
  resolveSymbolPosition,
  sortDedupeDiagnostics,
} from './lsp.js'

const here = dirname(fileURLToPath(import.meta.url))
const fakeServerScript = join(here, '..', '..', 'lsp', 'fixtures', 'fake-server.mjs')
const tmpBase = await mkdtemp(join(tmpdir(), 'lsp-tool-'))
const prevConfigDir = process.env.C0DE_CONFIG_DIR
const prevPath = process.env.PATH

const SRC_CONTENT = [
  'const fooBar = 1',
  'const foo = fooBar + 1',
  'function main() {',
  '  return foo',
  '}',
].join('\n')

/** 工作区：package.json 根标记 + src/a.ts + node_modules/.bin 假 language server。 */
async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpBase, 'ws-'))
  await writeFile(join(root, 'package.json'), '{}')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'a.ts'), SRC_CONTENT)
  await installFakeServer(root)
  return root
}

async function installFakeServer(root: string): Promise<void> {
  const binDir = join(root, 'node_modules', '.bin')
  await mkdir(binDir, { recursive: true })
  const bin = join(binDir, 'typescript-language-server')
  await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${fakeServerScript}" "$@"\n`)
  await chmod(bin, 0o755)
}

function ctxFor(cwd: string) {
  return { cwd, session: { id: 'test-session', cwd }, abort: new AbortController().signal }
}

beforeAll(async () => {
  // 隔离全局配置：resolveServers 只见内置默认表。
  process.env.C0DE_CONFIG_DIR = await mkdtemp(join(tmpBase, 'cfg-'))
})

afterAll(async () => {
  process.env.C0DE_CONFIG_DIR = prevConfigDir
  process.env.PATH = prevPath
  await defaultLspManager.disposeAll()
  await rm(tmpBase, { recursive: true, force: true })
})

describe('symbol spec parsing', () => {
  it('parses name / name#N (greedy so #field#2 keeps the hash in the symbol)', () => {
    expect(parseSymbolSpec('foo')).toEqual({ symbol: 'foo', occurrence: 1 })
    expect(parseSymbolSpec('foo#2')).toEqual({ symbol: 'foo', occurrence: 2 })
    expect(parseSymbolSpec('#field#3')).toEqual({ symbol: '#field', occurrence: 3 })
    expect(parseSymbolSpec('a.b')).toEqual({ symbol: 'a.b', occurrence: 1 })
  })

  it('requires word boundaries for bare identifiers, substring otherwise', () => {
    const line = 'const foo = fooBar + foobar2'
    expect(findSymbolMatchIndexes(line, 'foo')).toEqual([6])
    expect(findSymbolMatchIndexes(line, 'fooBar')).toEqual([12])
    // 非裸标识符（含 . / # 等）退化为子串匹配。
    expect(findSymbolMatchIndexes(line, 'foo.b')).toEqual([])
    expect(findSymbolMatchIndexes('a foo.b c', 'foo.b')).toEqual([2])
  })

  it('resolves position with #N and falls back to case-insensitive', async () => {
    const file = join(tmpBase, 'sym.ts')
    await writeFile(file, 'let Foo = 1; let Foo = 2\n')
    expect(await resolveSymbolPosition(file, 1, 'Foo')).toEqual({ line0: 0, character0: 4 })
    expect(await resolveSymbolPosition(file, 1, 'Foo#2')).toEqual({ line0: 0, character0: 17 })
    // 精确大小写无命中 → 大小写不敏感放宽。
    expect(await resolveSymbolPosition(file, 1, 'foo')).toEqual({ line0: 0, character0: 4 })
  })

  it('errors with the line content so the model can self-correct', async () => {
    const file = join(tmpBase, 'miss.ts')
    await writeFile(file, 'const fooBar = 1\n')
    await expect(resolveSymbolPosition(file, 1, 'nope')).rejects.toThrow(
      /not found on line 1.*const fooBar/s,
    )
    await expect(resolveSymbolPosition(file, 9, 'foo')).rejects.toThrow(/out of range/)
    await expect(resolveSymbolPosition(file, 1, 'fooBar#5')).rejects.toThrow(
      /occurrence #5 is out of range/,
    )
  })
})

describe('lsp tool input handling', () => {
  it('rejects unknown actions and missing required fields', async () => {
    const ws = await makeWorkspace()
    const ctx = ctxFor(ws)
    const bad = (await lspTool.execute({ action: 'bogus' }, ctx)) as {
      _tag: string
      error?: string
    }
    expect(bad._tag).toBe('error')
    expect(bad.error).toContain('invalid action')
    const noLine = (await lspTool.execute(
      { action: 'definition', file: 'src/a.ts', symbol: 'foo' },
      ctx,
    )) as {
      error?: string
    }
    expect(noLine.error).toContain('"line"')
  })

  it('reports when no language server matches the extension', async () => {
    const ws = await makeWorkspace()
    const result = (await lspTool.execute(
      { action: 'diagnostics', file: 'data.zzz' },
      ctxFor(ws),
    )) as {
      _tag: string
      error?: string
    }
    expect(result._tag).toBe('error')
    expect(result.error).toContain('no language server is configured')
    expect(result.error).toContain('typescript-language-server')
  })

  it('reports when the matched server binary is missing', async () => {
    const root = await mkdtemp(join(tmpBase, 'ws-nobin-'))
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(root, 'a.ts'), SRC_CONTENT)
    const emptyPathDir = join(tmpBase, 'empty-path')
    await mkdir(emptyPathDir, { recursive: true })
    const prev = process.env.PATH
    process.env.PATH = emptyPathDir
    try {
      const result = (await lspTool.execute(
        { action: 'hover', file: 'a.ts', line: 2, symbol: 'foo' },
        ctxFor(root),
      )) as {
        _tag: string
        error?: string
      }
      expect(result._tag).toBe('error')
      expect(result.error).toContain('binary not found')
      expect(result.error).toContain('node_modules/.bin')
    } finally {
      process.env.PATH = prev
    }
  })
})

describe('lsp tool end-to-end (fake language server)', () => {
  it('definition returns file:line:col with context (LocationLink normalized)', async () => {
    const ws = await makeWorkspace()
    const result = (await lspTool.execute(
      { action: 'definition', file: 'src/a.ts', line: 2, symbol: 'foo' },
      ctxFor(ws),
    )) as { _tag: string; output: string }
    expect(result._tag).toBe('success')
    // 假服务器 definition 回 LocationLink：targetSelectionRange line2 char4 → 1-based 3:5。
    expect(result.output).toContain('[typescript-language-server] 1 location(s)')
    expect(result.output).toContain('src/a.ts:3:5')
    expect(result.output).toMatch(/2 \| const foo = fooBar \+ 1/)
  })

  it('references retries on empty results and reports locations', async () => {
    const ws = await makeWorkspace()
    const result = (await lspTool.execute(
      { action: 'references', file: 'src/a.ts', line: 2, symbol: 'foo' },
      ctxFor(ws),
    )) as { _tag: string; output: string }
    expect(result._tag).toBe('success')
    // 假服务器第一次 references 回 []（触发重试），第二次回 line3 char2 → 4:3。
    expect(result.output).toContain('1 reference(s)')
    expect(result.output).toContain('src/a.ts:4:3')
  })

  it('hover flattens MarkedString arrays to plain text', async () => {
    const ws = await makeWorkspace()
    const result = (await lspTool.execute(
      { action: 'hover', file: 'src/a.ts', line: 2, symbol: 'foo' },
      ctxFor(ws),
    )) as { _tag: string; output: string }
    expect(result._tag).toBe('success')
    expect(result.output).toContain('const foo: number')
    expect(result.output).toContain('also plain text')
  })

  it('symbols flattens the DocumentSymbol hierarchy and SymbolInformation entries', async () => {
    const ws = await makeWorkspace()
    const result = (await lspTool.execute({ action: 'symbols', file: 'src/a.ts' }, ctxFor(ws))) as {
      _tag: string
      output: string
    }
    expect(result._tag).toBe('success')
    expect(result.output).toContain('alpha Function 1')
    expect(result.output).toContain('  beta Method 2')
    expect(result.output).toContain('gamma Variable 5')
  })

  it('diagnostics sorts by severity, dedupes, and groups output', async () => {
    const ws = await makeWorkspace()
    const result = (await lspTool.execute(
      { action: 'diagnostics', file: 'src/a.ts' },
      ctxFor(ws),
    )) as {
      _tag: string
      output: string
    }
    expect(result._tag).toBe('success')
    expect(result.output).toContain('(1 error, 1 warning)')
    expect(result.output).toContain('error:')
    expect(result.output).toContain('fake error')
    expect(result.output).toContain('warning:')
    expect(result.output).toContain('[fake] fake warning')
    // error 在 warning 前（severity 排序）。
    expect(result.output.indexOf('fake error')).toBeLessThan(result.output.indexOf('fake warning'))
  })

  it('status lists servers with binary availability', async () => {
    const ws = await makeWorkspace()
    // 清空 PATH：只有 .bin 里的假 tsserver 可用，其余服务器必然 missing。
    const emptyPathDir = join(tmpBase, 'empty-path')
    await mkdir(emptyPathDir, { recursive: true })
    const prev = process.env.PATH
    process.env.PATH = emptyPathDir
    try {
      const result = (await lspTool.execute({ action: 'status' }, ctxFor(ws))) as {
        _tag: string
        output: string
      }
      expect(result._tag).toBe('success')
      expect(result.output).toContain('typescript-language-server')
      expect(result.output).toContain('binary ok')
      expect(result.output).toContain('rust-analyzer')
      expect(result.output).toMatch(/binary missing/)
    } finally {
      process.env.PATH = prev
    }
  })
})

describe('lsp_rename tool', () => {
  it('apply=false only previews the edits', async () => {
    const ws = await makeWorkspace()
    const result = (await lspRenameTool.execute(
      { file: 'src/a.ts', line: 2, symbol: 'foo', new_name: 'qux', apply: false },
      ctxFor(ws),
    )) as { _tag: string; output: string }
    expect(result._tag).toBe('success')
    expect(result.output).toContain('NOT applied')
    expect(result.output).toContain('src/a.ts:1:1')
    expect(await readFile(join(ws, 'src', 'a.ts'), 'utf8')).toBe(SRC_CONTENT)
  })

  it('apply=true writes edits to disk and reports the change', async () => {
    const ws = await makeWorkspace()
    const result = (await lspRenameTool.execute(
      { file: 'src/a.ts', line: 2, symbol: 'foo', new_name: 'qux' },
      ctxFor(ws),
    )) as { _tag: string; output: string }
    expect(result._tag).toBe('success')
    expect(result.output).toContain('1 edit(s) in 1 file(s)')
    // 假服务器 rename：行首插入 newName。
    expect(await readFile(join(ws, 'src', 'a.ts'), 'utf8')).toBe(`qux${SRC_CONTENT}`)
    expect(result.output).toContain('re-synced language servers')
  })
})

describe('edit application', () => {
  it('applies single-line and multi-line edits bottom-up', () => {
    const content = 'aaa\nbbb\nccc\nddd'
    const edits = [
      {
        range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
        newText: 'XX',
      },
      {
        range: { start: { line: 1, character: 1 }, end: { line: 2, character: 1 } },
        newText: 'Y\nZ',
      },
    ]
    // 行2 替换 bb..c 之间为 Y\nZ；行1 a[a]a → aXXa。
    expect(applyTextEditsToString(content, edits)).toBe('aXXa\nbY\nZcc\nddd')
  })

  it('sortDedupeDiagnostics orders by severity then position and dedupes', () => {
    const list = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 2 as const,
        message: 'w',
      },
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
        severity: 1 as const,
        message: 'e1',
      },
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
        severity: 1 as const,
        message: 'e1',
      },
    ]
    const out = sortDedupeDiagnostics(list)
    expect(out).toHaveLength(2)
    expect(out[0]?.message).toBe('e1')
    expect(out[1]?.message).toBe('w')
  })
})

describe('registration', () => {
  it('createDefaultRegistry registers lsp and lsp_rename', () => {
    const names = listTools(createDefaultRegistry()).map((t) => t.name)
    expect(names).toContain('lsp')
    expect(names).toContain('lsp_rename')
  })
})
