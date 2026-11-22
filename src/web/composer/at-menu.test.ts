// @ 提及候选的纯逻辑：候选列表只算一次，键盘索引与浮层渲染共用（at-menu.ts）。
import { describe, expect, it } from 'vitest'
import { AT_MAX_FILES, AT_MAX_SUBAGENTS, atMenuItems, atMenuSelection } from '@/composer/at-menu.js'
import type { FileSearchResult } from '@/hooks/useFiles.js'
import type { AgentListItem } from '@/services/agent.js'

const file = (path: string): FileSearchResult => ({ path, type: 'file' })
const agent = (name: string, mode: AgentListItem['mode'] = 'subagent'): AgentListItem => ({
  name,
  description: '',
  mode,
  source: '.c0de/agents',
  hasTools: true,
})

/** 搜索接口不设上限，真实仓库里一次命中几百个是常态。 */
const manyFiles = (n: number) => Array.from({ length: n }, (_, i) => file(`src/f${i}.ts`))

describe('atMenuItems', () => {
  it('文件段截断到展示上限（键盘索引空间此前是完整搜索结果）', () => {
    const items = atMenuItems({ agents: [], results: manyFiles(30), query: 'f' })
    expect(items.files).toHaveLength(AT_MAX_FILES)
    expect(items.files[0]?.path).toBe('src/f0.ts')
    expect(items.files[AT_MAX_FILES - 1]?.path).toBe('src/f19.ts')
  })

  it('agent 段滤掉 primary 并截断到上限', () => {
    const items = atMenuItems({
      agents: [
        agent('primary-one', 'primary'),
        ...Array.from({ length: 8 }, (_, i) => agent(`a${i}`)),
      ],
      results: [],
      query: 'a',
    })
    expect(items.subagents).toHaveLength(AT_MAX_SUBAGENTS)
    expect(items.subagents.map((a) => a.mode)).not.toContain('primary')
  })

  it('query 只过滤 agent 名，新鲜文件项由服务端搜索给出（不重复过滤）', () => {
    const items = atMenuItems({
      agents: [agent('alpha'), agent('beta')],
      results: manyFiles(3),
      query: 'alph',
    })
    expect(items.subagents.map((a) => a.name)).toEqual(['alpha'])
    expect(items.files).toHaveLength(3)
  })
})

/**
 * oh-my-pi autocomplete 移植的新契约（at-completion.ts + at-menu 收窄/排序）：
 * 在途收窄、目录候选、分层排序。锁定的是可感知行为：逐字收窄不闪空、目录可
 * 下钻、basename 命中排在深层路径命中之前。
 */
describe('atMenuItems 的 oh-my-pi 补全口径', () => {
  const dir = (path: string): FileSearchResult => ({ path, type: 'directory' })

  it('stale（新查询在途）时按 query 子序列收窄旧结果，而不是清空', () => {
    const items = atMenuItems({
      agents: [],
      // 上一查询 's' 的结果（服务端子串匹配口径的超集）
      results: [file('src/app.ts'), file('src/store.ts'), file('docs/readme.md')],
      query: 'st',
      stale: true,
    })
    // 'src/app.ts' 经 ".ts" 的 s…t 子序列仍命中（收窄是子序列口径，非前缀）；
    // 'docs/readme.md' 无 's'，被收窄掉；排序把相邻命中 'store' 提到最前
    expect(items.files.map((f) => f.path)).toEqual(['src/store.ts', 'src/app.ts'])
  })

  it('stale 收窄是子序列口径："src" 也命中 a/src.ts 这类中缀形态', () => {
    const items = atMenuItems({
      agents: [],
      results: [file('a/src.ts'), file('a/other.ts')],
      query: 'src',
      stale: true,
    })
    expect(items.files.map((f) => f.path)).toEqual(['a/src.ts'])
  })

  it('目录候选进入列表（不再被丢弃），同分时排在文件前', () => {
    const items = atMenuItems({
      agents: [],
      // 两者都是「路径包含」700 分档（basename 都不以 query 开头）：目录在前
      results: [file('docs/mycomp/notes.ts'), dir('docs/mycomp')],
      query: 'comp',
    })
    expect(items.files.map((f) => f.path)).toEqual(['docs/mycomp', 'docs/mycomp/notes.ts'])
  })

  it('basename 前缀命中排在深层路径包含命中之前（分层排序）', () => {
    const items = atMenuItems({
      agents: [],
      // 服务端子串匹配下三者同命中 'read'；walk 序里深层路径在前
      results: [file('src/a/read/x.ts'), file('src/readme.md'), dir('docs/reading')],
      query: 'read',
    })
    // basename 前缀档（900，目录在前）：reading/、readme.md；路径包含档（700）：x.ts
    expect(items.files.map((f) => f.path)).toEqual([
      'docs/reading',
      'src/readme.md',
      'src/a/read/x.ts',
    ])
  })

  it('query 以 / 结尾（目录下钻）时，该目录的直接子项排在深层路径前', () => {
    const items = atMenuItems({
      agents: [],
      results: [
        file('src/web/deep/nested/file.ts'),
        dir('src/web'),
        file('src/web/composer'),
        file('src/web/main.ts'),
      ],
      query: 'src/web/',
    })
    // 直接子项（950 档，稳定保持来源顺序）优先；深层路径退到包含档（700）；
    // 前缀目录自身（'src/web' 不含 'src/web/'）落 0 分垫底
    expect(items.files.map((f) => f.path)).toEqual([
      'src/web/composer',
      'src/web/main.ts',
      'src/web/deep/nested/file.ts',
      'src/web',
    ])
  })

  it('空 query（裸 @）不列文件：旧查询的 placeholder 残留不得混入', () => {
    const items = atMenuItems({
      agents: [agent('alpha')],
      results: [file('src/a.ts')],
      query: '',
      stale: true,
    })
    expect(items.files).toEqual([])
    expect(items.subagents.map((a) => a.name)).toEqual(['alpha'])
  })
})

describe('atMenuSelection', () => {
  it('下标落在 agent 段还是文件段由 agent 数量决定', () => {
    // query 非空：空 query（裸 @）的新契约不列文件（见上一 describe）
    const items = atMenuItems({ agents: [agent('alpha')], results: [file('a.ts')], query: 'a' })
    expect(atMenuSelection(items, 0)).toEqual({
      kind: 'agent',
      agent: expect.objectContaining({ name: 'alpha' }),
    })
    expect(atMenuSelection(items, 1)).toEqual({
      kind: 'file',
      file: expect.objectContaining({ path: 'a.ts' }),
    })
  })

  it('越界下标不返回任何候选（此前会把第 21 个未渲染文件插进 prompt）', () => {
    const items = atMenuItems({ agents: [], results: manyFiles(30), query: 'f' })
    expect(atMenuSelection(items, AT_MAX_FILES)).toBeNull()
    expect(atMenuSelection(items, AT_MAX_FILES - 1)).toEqual({
      kind: 'file',
      file: expect.objectContaining({ path: 'src/f19.ts' }),
    })
    expect(atMenuSelection(items, -1)).toBeNull()
  })
})
