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

  it('query 只过滤 agent 名，文件项由服务端搜索给出', () => {
    const items = atMenuItems({
      agents: [agent('alpha'), agent('beta')],
      results: manyFiles(3),
      query: 'alph',
    })
    expect(items.subagents.map((a) => a.name)).toEqual(['alpha'])
    expect(items.files).toHaveLength(3)
  })
})

describe('atMenuSelection', () => {
  it('下标落在 agent 段还是文件段由 agent 数量决定', () => {
    const items = atMenuItems({ agents: [agent('alpha')], results: [file('a.ts')], query: '' })
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
