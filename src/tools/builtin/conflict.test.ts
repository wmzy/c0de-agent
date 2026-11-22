import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolContext } from '../../shared/types/tool.js'
import { createURLRegistry, registerURLResolver } from '../resolver.js'
import {
  ConflictRegistry,
  expandContentTokens,
  parseConflictUri,
  resolveConflict,
  scanConflictMarkers,
} from './conflict.js'
import { createConflictResolver } from './conflict-resolver.js'
import { readTool } from './read.js'
import { writeTool } from './write.js'

let workDir: string
// 模块级注册表按 sessionId 隔离：每个用例用独立会话 id，避免 id 计数互相串
let sessionSeq = 0
let ctx: ToolContext

beforeEach(async () => {
  workDir = join(tmpdir(), `conflict-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(workDir, { recursive: true })
  sessionSeq += 1
  ctx = {
    cwd: workDir,
    session: { id: `conflict-s-${sessionSeq}`, cwd: workDir },
    abort: new AbortController().signal,
  }
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

/** 两块冲突的标准夹具文件内容（2-way + 3-way 各一）。 */
function twoBlockFile(): string {
  return [
    'intro',
    '<<<<<<< HEAD',
    'ours-1',
    '||||||| base',
    'base-1',
    '=======',
    'theirs-1',
    '>>>>>>> feature/x',
    'middle',
    '<<<<<<< HEAD',
    'ours-2',
    '=======',
    'theirs-2',
    '>>>>>>> feature/x',
    'outro',
  ].join('\n')
}

/** 读取 workDir 下的文件并按行拆开（断言用）。 */
async function readLines(name: string): Promise<string[]> {
  return (await readFile(join(workDir, name), 'utf-8')).split('\n')
}

describe('scanConflictMarkers', () => {
  it('detects a labeled 2-way block with exact line numbers', () => {
    const lines = ['a', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature/x', 'z']
    const blocks = scanConflictMarkers(lines, 1)
    expect(blocks).toHaveLength(1)
    const block = blocks[0]
    if (!block) throw new Error('unreachable')
    expect(block.startLine).toBe(2)
    expect(block.separatorLine).toBe(4)
    expect(block.endLine).toBe(6)
    expect(block.baseLine).toBeUndefined()
    expect(block.oursLabel).toBe('HEAD')
    expect(block.theirsLabel).toBe('feature/x')
    expect(block.oursLines).toEqual(['ours'])
    expect(block.theirsLines).toEqual(['theirs'])
  })

  it('detects a 3-way diff3 block with base section', () => {
    const blocks = scanConflictMarkers(
      ['<<<<<<< HEAD', 'ours', '||||||| ancestor', 'base', '=======', 'theirs', '>>>>>>> b'],
      1,
    )
    expect(blocks).toHaveLength(1)
    const block = blocks[0]
    if (!block) throw new Error('unreachable')
    expect(block.baseLine).toBe(3)
    expect(block.baseLabel).toBe('ancestor')
    expect(block.baseLines).toEqual(['base'])
  })

  it('returns multiple blocks in file order with offset firstLine', () => {
    const lines = [
      'padding',
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
    ]
    const blocks = scanConflictMarkers(lines, 100)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.oursLabel).toBe('A')
    expect(blocks[0]?.startLine).toBe(101)
    expect(blocks[1]?.oursLabel).toBe('B')
    expect(blocks[1]?.startLine).toBe(107)
    expect(blocks[1]?.endLine).toBe(111)
  })

  it('ignores indented or mis-shaped marker lookalikes', () => {
    const blocks = scanConflictMarkers(
      [
        '  <<<<<<< HEAD', // 缩进
        '\t=======',
        ' >>>>>>> branch',
        '<<<<<<<HEAD', // 贴字：前缀后必须恰好一个空格或行尾
        '========', // 8 个 =：不是裸 separator
        '>>>>>>>x',
        'const s = "=======";',
        'plain',
      ],
      1,
    )
    expect(blocks).toEqual([])
  })

  it('treats a re-opened opener as a fresh block (nested pseudo-block)', () => {
    const blocks = scanConflictMarkers(
      ['<<<<<<< first', 'stale', '<<<<<<< second', 'good', '=======', 'theirs', '>>>>>>> end'],
      1,
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.oursLabel).toBe('second')
    expect(blocks[0]?.oursLines).toEqual(['good'])
  })

  it('drops an unclosed block at the window tail', () => {
    expect(scanConflictMarkers(['<<<<<<< HEAD', 'ours', '=======', 'theirs'], 1)).toEqual([])
    expect(scanConflictMarkers(['ok', '<<<<<<< HEAD'], 1)).toEqual([])
  })

  it('accepts label-less markers and strips trailing CR', () => {
    const blocks = scanConflictMarkers(
      [
        '<<<<<<<',
        'ours',
        '=======',
        'theirs',
        '>>>>>>>',
        '<<<<<<<\r',
        'o\r',
        '=======\r',
        't\r',
        '>>>>>>>\r',
      ],
      1,
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.oursLabel).toBeUndefined()
    expect(blocks[1]?.oursLines).toEqual(['o'])
  })
})

describe('parseConflictUri', () => {
  it('parses id, scoped, and wildcard forms', () => {
    expect(parseConflictUri('conflict://3')).toEqual({ id: 3 })
    expect(parseConflictUri('conflict://3/theirs')).toEqual({ id: 3, scope: 'theirs' })
    expect(parseConflictUri('conflict://*')).toEqual({ id: '*' })
    expect(parseConflictUri('file://x')).toBeNull()
  })

  it('rejects malformed ids, scopes, and wildcard scopes', () => {
    expect(() => parseConflictUri('conflict://abc')).toThrow(/must be/)
    expect(() => parseConflictUri('conflict://0')).toThrow(/>= 1/)
    expect(() => parseConflictUri('conflict://1/other')).toThrow(/scope/)
    expect(() => parseConflictUri('conflict://*/ours')).toThrow(/wildcard/)
  })
})

describe('expandContentTokens', () => {
  const entry = {
    id: 1,
    absolutePath: '/x',
    startLine: 1,
    separatorLine: 3,
    endLine: 5,
    oursLines: ['o1', 'o2'],
    baseLines: ['b1'],
    theirsLines: ['t1'],
  }

  it('expands @theirs, @base and @both from the recorded sections', () => {
    expect(expandContentTokens('@theirs', entry)).toEqual(['t1'])
    expect(expandContentTokens('@base', entry)).toEqual(['b1'])
    expect(expandContentTokens('@both', entry)).toEqual(['o1', 'o2', 't1'])
  })

  it('expands tokens inline with literal lines and keeps partial matches verbatim', () => {
    expect(expandContentTokens('// keep\n@ours\n@theirs', entry)).toEqual([
      '// keep',
      'o1',
      'o2',
      't1',
    ])
    expect(expandContentTokens('x@ours @theirs', entry)).toEqual(['x@ours @theirs'])
  })

  it('throws for @base on a 2-way conflict', () => {
    const twoWay = { ...entry, baseLines: undefined }
    expect(() => expandContentTokens('@base', twoWay)).toThrow(/no base section/)
  })

  it('keeps an empty section expansion distinct from a typed empty line', () => {
    expect(expandContentTokens('@theirs', { ...entry, theirsLines: [] })).toEqual([])
    expect(expandContentTokens('', entry)).toEqual([''])
  })
})

describe('ConflictRegistry', () => {
  it('reuses ids for identical re-reads and rotates them when content drifts', () => {
    const registry = new ConflictRegistry()
    const block = {
      startLine: 2,
      separatorLine: 4,
      endLine: 6,
      oursLines: ['o'],
      theirsLines: ['t'],
    }
    const first = registry.register('/f', [block])
    expect(first[0]?.id).toBe(1)
    const again = registry.register('/f', [block])
    expect(again[0]?.id).toBe(1)
    // 同位置内容变了：旧 id 作废，分配新 id
    const drifted = registry.register('/f', [{ ...block, oursLines: ['changed'] }])
    expect(drifted[0]?.id).toBe(2)
    expect(registry.get(1)).toBeUndefined()
    expect(registry.entries()).toHaveLength(1)
  })

  it('caps entries per session, evicting the oldest ids', () => {
    const registry = new ConflictRegistry()
    for (let i = 0; i < 205; i++) {
      registry.register('/f', [
        {
          startLine: i + 1,
          separatorLine: i + 3,
          endLine: i + 5,
          oursLines: [`o${i}`],
          theirsLines: ['t'],
        },
      ])
    }
    expect(registry.entries()).toHaveLength(200)
    expect(registry.get(5)).toBeUndefined()
    expect(registry.get(6)).toBeDefined()
    expect(registry.get(205)).toBeDefined()
  })

  it('retires unmatched entries on reconcileScanned and follows relocations', async () => {
    await writeFile(join(workDir, 'f.txt'), twoBlockFile())
    const path = join(workDir, 'f.txt')
    const registry = new ConflictRegistry()
    const blocks = scanConflictMarkers((await readFile(path, 'utf-8')).split('\n'), 1)
    const entries = registry.register(path, blocks)
    expect(entries).toHaveLength(2)

    // 上方插入两行：两块整体下移（漂移跟随，id 不变）
    const shifted = ['n1', 'n2', ...(await readFile(path, 'utf-8')).split('\n')].join('\n')
    await writeFile(path, shifted)
    await registry.reconcile(path)
    expect(registry.get(entries[0]?.id ?? 0)).toBeDefined()
    expect(registry.get(entries[0]?.id ?? 0)?.startLine).toBe((entries[0]?.startLine ?? 0) + 2)

    // 第二块被手改：其 id 退役，第一块保留
    const lines = shifted.split('\n')
    const second = registry.get(entries[1]?.id ?? 0)
    if (!second) throw new Error('unreachable')
    lines.splice(second.startLine - 1, second.endLine - second.startLine + 1, 'resolved by hand')
    await writeFile(path, lines.join('\n'))
    await registry.reconcile(path)
    expect(registry.get(entries[1]?.id ?? 0)).toBeUndefined()
    expect(registry.get(entries[0]?.id ?? 0)).toBeDefined()

    // 文件删除：全部退役
    await rm(path)
    await registry.reconcile(path)
    expect(registry.entries()).toHaveLength(0)
  })
})

describe('resolveConflict (single id)', () => {
  it('splices @theirs over the recorded block and updates the registry', async () => {
    await writeFile(join(workDir, 'f.txt'), twoBlockFile())
    const read1 = await readTool.execute({ path: 'f.txt' }, ctx)
    expect(read1._tag).toBe('success')

    const result = await resolveConflict(1, '@theirs', {
      cwd: workDir,
      sessionId: ctx.session.id,
    })
    expect(result).toContain('Resolved conflict #1')
    // 第一块被 theirs 替换（含 base 段整体消失），第二块原样保留
    expect(await readLines('f.txt')).toEqual([
      'intro',
      'theirs-1',
      'middle',
      '<<<<<<< HEAD',
      'ours-2',
      '=======',
      'theirs-2',
      '>>>>>>> feature/x',
      'outro',
    ])

    // 再读一次：只剩一个冲突，footer 数量更新
    const read2 = await readTool.execute({ path: 'f.txt' }, ctx)
    expect(read2._tag).toBe('success')
    if (read2._tag === 'success') {
      expect(read2.output).toContain('[conflict] file has 1 unresolved conflict(s)')
    }
  })

  it('keeps later ids valid after earlier blocks are resolved (跨块部分解后 id 复检)', async () => {
    await writeFile(join(workDir, 'f.txt'), twoBlockFile())
    await readTool.execute({ path: 'f.txt' }, ctx)

    expect(
      await resolveConflict(1, '@ours', { cwd: workDir, sessionId: ctx.session.id }),
    ).toContain('#1')
    // 第一块解掉后行号整体上移；id=2 经 reconcile 重定位后仍可直接解
    const second = await resolveConflict(2, '@both', { cwd: workDir, sessionId: ctx.session.id })
    expect(second).toContain('Resolved conflict #2')
    expect(await readLines('f.txt')).toEqual([
      'intro',
      'ours-1',
      'middle',
      'ours-2',
      'theirs-2',
      'outro',
    ])
  })

  it('resolves with literal content, a typed empty line, and full block removal', async () => {
    await writeFile(
      join(workDir, 'lit.txt'),
      ['pre', '<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> x', 'post'].join('\n'),
    )
    await readTool.execute({ path: 'lit.txt' }, ctx)
    await resolveConflict(1, 'merged line 1\nmerged line 2', {
      cwd: workDir,
      sessionId: ctx.session.id,
    })
    expect(await readLines('lit.txt')).toEqual(['pre', 'merged line 1', 'merged line 2', 'post'])

    // 空 content 是「敲了一个空行」→ 保留一个空行
    await writeFile(
      join(workDir, 'del.txt'),
      ['pre', '<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> x', 'post'].join('\n'),
    )
    const ctx2 = { ...ctx, session: { ...ctx.session, id: `${ctx.session.id}-del` } }
    await readTool.execute({ path: 'del.txt' }, ctx2)
    await resolveConflict(1, '', { cwd: workDir, sessionId: ctx2.session.id })
    expect(await readLines('del.txt')).toEqual(['pre', '', 'post'])

    // 纯 token 且该侧为空 → 整块删除不留行
    await writeFile(
      join(workDir, 'gone.txt'),
      ['pre', '<<<<<<< HEAD', 'a', '=======', '>>>>>>> x', 'post'].join('\n'),
    )
    const ctx3 = { ...ctx, session: { ...ctx.session, id: `${ctx.session.id}-gone` } }
    await readTool.execute({ path: 'gone.txt' }, ctx3)
    await resolveConflict(1, '@theirs', { cwd: workDir, sessionId: ctx3.session.id })
    expect(await readLines('gone.txt')).toEqual(['pre', 'post'])
  })

  it('still resolves after out-of-band edits shift lines above the block', async () => {
    await writeFile(
      join(workDir, 'shift.txt'),
      ['head', '<<<<<<< HEAD', 'o', '=======', 't', '>>>>>>> x', 'tail'].join('\n'),
    )
    await readTool.execute({ path: 'shift.txt' }, ctx)
    const original = await readFile(join(workDir, 'shift.txt'), 'utf-8')
    await writeFile(join(workDir, 'shift.txt'), `extra1\nextra2\n${original}`)
    const result = await resolveConflict(1, '@theirs', { cwd: workDir, sessionId: ctx.session.id })
    expect(result).toContain('Resolved conflict #1')
    expect(await readLines('shift.txt')).toEqual(['extra1', 'extra2', 'head', 't', 'tail'])
  })

  it('rejects when the conflict block was changed on disk after registration (stale)', async () => {
    await writeFile(
      join(workDir, 'stale.txt'),
      ['<<<<<<< HEAD', 'o', '=======', 't', '>>>>>>> x'].join('\n'),
    )
    await readTool.execute({ path: 'stale.txt' }, ctx)
    // out-of-band：把 theirs 侧改掉（块还在但内容已非所记录）
    await writeFile(
      join(workDir, 'stale.txt'),
      ['<<<<<<< HEAD', 'o', '=======', 'CHANGED', '>>>>>>> x'].join('\n'),
    )
    await expect(
      resolveConflict(1, '@theirs', { cwd: workDir, sessionId: ctx.session.id }),
    ).rejects.toThrow(/became stale|no longer present/)
    // 磁盘内容不被写坏
    expect(await readLines('stale.txt')).toEqual([
      '<<<<<<< HEAD',
      'o',
      '=======',
      'CHANGED',
      '>>>>>>> x',
    ])
  })

  it('rejects unknown ids with the currently registered list', async () => {
    await writeFile(join(workDir, 'f.txt'), twoBlockFile())
    await readTool.execute({ path: 'f.txt' }, ctx)
    await expect(
      resolveConflict(9, '@ours', { cwd: workDir, sessionId: ctx.session.id }),
    ).rejects.toThrow(/#9 not found[\s\S]*Registered: #1, #2 in/)
  })

  it('round-trips CRLF line endings', async () => {
    await writeFile(
      join(workDir, 'crlf.txt'),
      ['pre\r', '<<<<<<< HEAD\r', 'o\r', '=======\r', 't\r', '>>>>>>> x\r', 'post\r'].join('\n'),
    )
    await readTool.execute({ path: 'crlf.txt' }, ctx)
    await resolveConflict(1, '@theirs', { cwd: workDir, sessionId: ctx.session.id })
    expect(await readLines('crlf.txt')).toEqual(['pre\r', 't\r', 'post\r'])
  })
})

describe('resolveConflict (bulk *)', () => {
  it('applies uniform content to every block with per-block token expansion', async () => {
    await writeFile(join(workDir, 'f.txt'), twoBlockFile())
    await readTool.execute({ path: 'f.txt' }, ctx)
    const result = await resolveConflict('*', '@theirs', {
      cwd: workDir,
      sessionId: ctx.session.id,
    })
    expect(result).toContain('Resolved 2 conflicts across 1 file(s)')
    expect(await readLines('f.txt')).toEqual(['intro', 'theirs-1', 'middle', 'theirs-2', 'outro'])
  })

  it('resolves per-id directives and leaves unlisted ids registered', async () => {
    const three = [
      '<<<<<<< A',
      'a-ours',
      '=======',
      'a-theirs',
      '>>>>>>> A',
      'mid',
      '<<<<<<< B',
      'b-ours',
      '=======',
      'b-theirs',
      '>>>>>>> B',
      'mid2',
      '<<<<<<< C',
      'c-ours',
      '=======',
      'c-theirs',
      '>>>>>>> C',
    ]
    await writeFile(join(workDir, 'three.txt'), three.join('\n'))
    await readTool.execute({ path: 'three.txt' }, ctx)
    const result = await resolveConflict('*', '1: @ours\n3: @theirs', {
      cwd: workDir,
      sessionId: ctx.session.id,
    })
    expect(result).toContain('Resolved 2 conflicts')
    expect(result).toContain('1 unlisted conflict still registered (#2)')
    expect(await readLines('three.txt')).toEqual([
      'a-ours',
      'mid',
      '<<<<<<< B',
      'b-ours',
      '=======',
      'b-theirs',
      '>>>>>>> B',
      'mid2',
      'c-theirs',
    ])
  })

  it('rejects a malformed per-id block instead of silently degrading to uniform mode', async () => {
    await writeFile(join(workDir, 'f.txt'), twoBlockFile())
    await readTool.execute({ path: 'f.txt' }, ctx)
    const writeCtx = { cwd: workDir, sessionId: ctx.session.id }
    // 混入字面量行：绝不静默降级成「把指令文本贴进每个块」
    await expect(resolveConflict('*', '1: @ours\n2: keep this literal', writeCtx)).rejects.toThrow(
      /Malformed.*not '<id>: @side' directives/,
    )
    // 纯 `<id>: <字面量>` 形态同样识别为畸形 per-id 块
    await expect(resolveConflict('*', '1: resolved text', writeCtx)).rejects.toThrow(/Malformed/)
    await expect(resolveConflict('*', '1: @ours\n1: @theirs', writeCtx)).rejects.toThrow(/twice/)
    await expect(resolveConflict('*', '7: @ours', writeCtx)).rejects.toThrow(/unknown conflict id/)
    // 磁盘未被任何失败尝试改动
    expect(await readFile(join(workDir, 'f.txt'), 'utf-8')).toBe(twoBlockFile())
  })

  it('throws when nothing is registered', async () => {
    await expect(
      resolveConflict('*', '@ours', { cwd: workDir, sessionId: `${ctx.session.id}-empty` }),
    ).rejects.toThrow(/nothing to resolve/)
  })
})

describe('conflict:// URL resolver', () => {
  function wiredCtx(): ToolContext {
    const registry = createURLRegistry()
    registerURLResolver(registry, createConflictResolver())
    return { ...ctx, urlRegistry: registry }
  }

  it('renders a registered block and its scoped sides', async () => {
    await writeFile(join(workDir, 'f.txt'), twoBlockFile())
    const wctx = wiredCtx()
    await readTool.execute({ path: 'f.txt' }, wctx)

    const bare = await readTool.execute({ path: 'conflict://1' }, wctx)
    expect(bare._tag).toBe('success')
    if (bare._tag === 'success') {
      expect(bare.output).toContain('#1 f.txt L2-L8')
      expect(bare.output).toContain('<<<<<<< HEAD')
      expect(bare.output).toContain('||||||| base')
      expect(bare.output).toContain('>>>>>>> feature/x')
    }

    const theirs = await readTool.execute({ path: 'conflict://1/theirs' }, wctx)
    expect(theirs._tag).toBe('success')
    if (theirs._tag === 'success') {
      expect(theirs.output).toContain('#1 f.txt L7 (theirs)')
      expect(theirs.output).toContain('theirs-1')
      expect(theirs.output).not.toContain('<<<<<<<')
    }

    const ours = await readTool.execute({ path: 'conflict://1/base' }, wctx)
    expect(ours._tag).toBe('success')
    if (ours._tag === 'success') expect(ours.output).toContain('base-1')
  })

  it('writes through the write tool and clears the conflict on re-read', async () => {
    await writeFile(
      join(workDir, 'w.txt'),
      ['pre', '<<<<<<< HEAD', 'o', '=======', 't', '>>>>>>> x', 'post'].join('\n'),
    )
    const wctx = wiredCtx()
    const read1 = await readTool.execute({ path: 'w.txt' }, wctx)
    expect(read1._tag).toBe('success')

    const written = await writeTool.execute({ path: 'conflict://1', content: '@ours' }, wctx)
    expect(written._tag).toBe('success')
    if (written._tag === 'success') expect(written.output).toContain('Resolved conflict #1')
    expect(await readLines('w.txt')).toEqual(['pre', 'o', 'post'])

    const read2 = await readTool.execute({ path: 'w.txt' }, wctx)
    expect(read2._tag).toBe('success')
    if (read2._tag === 'success') expect(read2.output).not.toContain('[conflict]')
  })

  it('bulk-writes through conflict://*', async () => {
    await writeFile(join(workDir, 'f.txt'), twoBlockFile())
    const wctx = wiredCtx()
    await readTool.execute({ path: 'f.txt' }, wctx)
    const written = await writeTool.execute(
      { path: 'conflict://*', content: '1: @base\n2: @ours' },
      wctx,
    )
    expect(written._tag).toBe('success')
    expect(await readLines('f.txt')).toEqual(['intro', 'base-1', 'middle', 'ours-2', 'outro'])
  })

  it('rejects wildcard reads and scoped writes', async () => {
    await writeFile(join(workDir, 'f.txt'), twoBlockFile())
    const wctx = wiredCtx()
    await readTool.execute({ path: 'f.txt' }, wctx)

    const wildcard = await readTool.execute({ path: 'conflict://*' }, wctx)
    expect(wildcard._tag).toBe('error')
    if (wildcard._tag === 'error') expect(wildcard.error).toContain('write-only')

    const scoped = await writeTool.execute({ path: 'conflict://1/ours', content: '@ours' }, wctx)
    expect(scoped._tag).toBe('error')
    if (scoped._tag === 'error') expect(scoped.error).toContain('read-only')
  })

  it('fails reads of unregistered ids with guidance', async () => {
    const wctx = wiredCtx()
    const missing = await readTool.execute({ path: 'conflict://5' }, wctx)
    expect(missing._tag).toBe('error')
    if (missing._tag === 'error') expect(missing.error).toContain('#5 not found')
  })
})
