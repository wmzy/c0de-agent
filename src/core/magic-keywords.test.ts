import { describe, expect, it } from 'vitest'
import { buildMagicKeywordNotices, containsKeyword } from './magic-keywords.js'

const ids = (notices: ReturnType<typeof buildMagicKeywordNotices>): string[] =>
  notices.map((n) => n.id)

describe('containsKeyword — standalone prose 检测', () => {
  it('命中独立小写词与 CJK 贴词', () => {
    expect(containsKeyword('ultrathink', 'ultrathink')).toBe(true)
    expect(containsKeyword('please ultrathink this', 'ultrathink')).toBe(true)
    expect(containsKeyword('请ultrathink，分析', 'ultrathink')).toBe(true)
    expect(containsKeyword('ultrathink。', 'ultrathink')).toBe(true)
    expect(containsKeyword('do this orchestrate, then report', 'orchestrate')).toBe(true)
  })

  it('拒绝大小写/复数/前后缀/路径/扩展名/调用式', () => {
    expect(containsKeyword('Ultrathink', 'ultrathink')).toBe(false)
    expect(containsKeyword('ULTRATHINK', 'ultrathink')).toBe(false)
    expect(containsKeyword('ultrathinks', 'ultrathink')).toBe(false)
    expect(containsKeyword('reultrathink everything', 'ultrathink')).toBe(false)
    expect(containsKeyword('modes/ultrathink.test.ts', 'ultrathink')).toBe(false)
    expect(containsKeyword('ultrathink.ts', 'ultrathink')).toBe(false)
    expect(containsKeyword('foo::ultrathink', 'ultrathink')).toBe(false)
    expect(containsKeyword('ultrathink()', 'ultrathink')).toBe(false)
    expect(containsKeyword('nothing here', 'ultrathink')).toBe(false)
    expect(containsKeyword('', 'ultrathink')).toBe(false)
  })

  it('代码区（围栏/未闭合围栏/多反引号 span/HTML）内不触发', () => {
    expect(containsKeyword('```\nultrathink\n```', 'ultrathink')).toBe(false)
    expect(containsKeyword('```ts\nconst x = "ultrathink"', 'ultrathink')).toBe(false)
    expect(containsKeyword('~~~\nultrathink\n~~~', 'ultrathink')).toBe(false)
    expect(containsKeyword('use `ultrathink` keyword', 'ultrathink')).toBe(false)
    expect(containsKeyword('use ``ultrathink`` keyword', 'ultrathink')).toBe(false)
    expect(containsKeyword('<!-- ultrathink -->', 'ultrathink')).toBe(false)
    expect(containsKeyword('<tag>ultrathink</tag>', 'ultrathink')).toBe(false)
  })

  it('代码与 prose 混排时 prose 命中', () => {
    expect(
      containsKeyword(
        'Here is code:\n```ts\nconst x = 1\n```\n\nNow ultrathink this.',
        'ultrathink',
      ),
    ).toBe(true)
  })
})

describe('buildMagicKeywordNotices — 表驱动 notice 构建', () => {
  const allTools = ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'task']

  it('ultrathink 无工具要求；workflowz 产工作流 notice', () => {
    const notices = buildMagicKeywordNotices('ultrathink this hard problem', {
      tools: ['read'],
      workflowList: [],
    })
    expect(ids(notices)).toEqual(['ultrathink'])
    expect(notices[0]?.content).toContain('<system-notice>')
  })

  it('requires 未满足则跳过（无 task 工具时 orchestrate/workflowz 静默）', () => {
    const notices = buildMagicKeywordNotices('orchestrate the migration workflowz', {
      tools: ['read', 'edit'],
      workflowList: [],
    })
    expect(notices).toEqual([])
  })

  it('orchestrate notice 列出本轮实际启用工具', () => {
    const notices = buildMagicKeywordNotices('orchestrate it', { tools: allTools })
    expect(ids(notices)).toEqual(['orchestrate'])
    expect(notices[0]?.content).toContain('read, write, edit, bash, grep, glob, task')
  })

  it('workflowz notice 含工作流清单', () => {
    const notices = buildMagicKeywordNotices('workflowz 扫描', {
      tools: allTools,
      workflowList: [{ name: 'code-review', description: '多维度审查' }],
    })
    expect(ids(notices)).toEqual(['workflow'])
    expect(notices[0]?.content).toContain('code-review')
  })

  it('多关键词同消息各自注入，顺序与表一致', () => {
    const notices = buildMagicKeywordNotices('ultrathink then orchestrate', { tools: allTools })
    expect(ids(notices)).toEqual(['ultrathink', 'orchestrate'])
  })

  it('配置开关：总开关与单关键词开关独立生效', () => {
    const text = 'ultrathink orchestrate workflowz'
    expect(buildMagicKeywordNotices(text, { tools: allTools, config: { enabled: false } })).toEqual(
      [],
    )
    expect(
      ids(
        buildMagicKeywordNotices(text, {
          tools: allTools,
          config: { enabled: true, ultrathink: false, orchestrate: true, workflow: false },
        }),
      ),
    ).toEqual(['orchestrate'])
  })

  it('代码区关键词不触发 notice', () => {
    const notices = buildMagicKeywordNotices('```\nultrathink\n```', { tools: allTools })
    expect(notices).toEqual([])
  })
})
