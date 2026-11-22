import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveGlobalConfigDir } from '../core/config.js'
import { discoverStreamRules } from './discover.js'
import { parseStreamRule } from './parse.js'

describe('parseStreamRule', () => {
  const parse = (md: string, source = '/rules/demo.md') => parseStreamRule(md, source)

  it('基础形态：string condition + 默认值（name 取文件名、scope text、once、gap 10）', () => {
    const result = parse('---\ncondition: "TODO\\(fix\\)"\n---\n正文指引')
    expect(result).toMatchObject({
      ok: true,
      rule: {
        name: 'demo',
        conditions: [/TODO\(fix\)/],
        scope: 'text',
        repeatMode: 'once',
        repeatGap: 10,
        body: '正文指引',
        source: '/rules/demo.md',
      },
    })
  })

  it('condition 接受 inline 数组与块列表两种形态', () => {
    const inline = parse('---\nname: inline-rule\ncondition: ["foo", \'bar\']\n---\nbody')
    expect(inline.ok).toBe(true)
    if (inline.ok) expect(inline.rule.conditions.map(String)).toEqual(['/foo/', '/bar/'])

    const block = parse('---\nname: block-rule\ncondition:\n  - foo\n  - "bar"\n---\nbody')
    expect(block.ok).toBe(true)
    if (block.ok) expect(block.rule.conditions.map(String)).toEqual(['/foo/', '/bar/'])
  })

  it('scope/repeatMode/repeatGap 显式合法值可解析', () => {
    const result = parse(
      '---\nscope: text\nrepeatMode: turn-gap\nrepeatGap: 3\ncondition: x\n---\nb',
    )
    expect(result).toMatchObject({ ok: true, rule: { repeatMode: 'turn-gap', repeatGap: 3 } })
    const always = parse('---\nrepeatMode: always\ncondition: x\n---\nb')
    expect(always).toMatchObject({ ok: true, rule: { repeatMode: 'always' } })
  })

  it('frontmatter 缺失报错跳过', () => {
    const result = parse('没有 frontmatter 的普通文档')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('frontmatter')
  })

  it('condition 缺失或全空报错跳过', () => {
    expect(parse('---\nname: no-cond\n---\nbody').ok).toBe(false)
    expect(parse('---\ncondition: []\n---\nbody').ok).toBe(false)
    expect(parse('---\ncondition:\n  - ""\n---\nbody').ok).toBe(false)
  })

  it('scope 非 text 报错跳过（一期仅支持 text）', () => {
    const result = parse('---\nscope: tool\ncondition: x\n---\nb')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('scope')
  })

  it('repeatMode 非法值报错跳过', () => {
    const result = parse('---\nrepeatMode: sometimes\ncondition: x\n---\nb')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('repeatMode')
  })

  it('repeatGap 非整数或 <1 报错跳过', () => {
    expect(parse('---\nrepeatGap: abc\ncondition: x\n---\nb').ok).toBe(false)
    expect(parse('---\nrepeatGap: 0\ncondition: x\n---\nb').ok).toBe(false)
    expect(parse('---\nrepeatGap: 2.5\ncondition: x\n---\nb').ok).toBe(false)
  })

  it('非法正则报错并跳过整条规则（fail-closed）', () => {
    const result = parse('---\ncondition: "[unclosed"\n---\nb')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('正则非法')
    // 多条件时任一非法也整条跳过
    expect(parse('---\ncondition:\n  - ok\n  - "(?P<x>bad)"\n---\nb').ok).toBe(false)
  })

  it('body 为 frontmatter 剥离后的正文（含多段与代码块）', () => {
    const md = [
      '---',
      'condition: x',
      '---',
      '',
      '第一段',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
    ].join('\n')
    const result = parse(md)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rule.body).toBe(['第一段', '', '```ts', 'const a = 1', '```'].join('\n'))
    }
  })
})

describe('discoverStreamRules', () => {
  let root: string
  const prevEnv = process.env.C0DE_CONFIG_DIR

  const writeRule = (dir: string, file: string, md: string): string => {
    mkdirSync(dir, { recursive: true })
    const source = join(dir, file)
    writeFileSync(source, md)
    return source
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'c0de-stream-rules-'))
    process.env.C0DE_CONFIG_DIR = join(root, 'global')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.C0DE_CONFIG_DIR
    else process.env.C0DE_CONFIG_DIR = prevEnv
  })

  const GLOBAL_MD = '---\nname: global-rule\ncondition: "global-[a-z]+"\n---\n全局指引'
  const PROJECT_MD = '---\nname: project-rule\ncondition: "project-[a-z]+"\n---\n项目指引'

  it('projectTrusted=true：全局与项目规则都发现', () => {
    writeRule(join(resolveGlobalConfigDir(), 'rules'), 'g.md', GLOBAL_MD)
    writeRule(join(root, 'proj', '.c0de', 'rules'), 'p.md', PROJECT_MD)

    const { rules, issues } = discoverStreamRules(join(root, 'proj'), { projectTrusted: true })
    expect(issues).toEqual([])
    expect(rules.map((rule) => rule.name).sort()).toEqual(['global-rule', 'project-rule'])
  })

  it('projectTrusted 缺省 false：只用全局规则（fail-closed）', () => {
    writeRule(join(resolveGlobalConfigDir(), 'rules'), 'g.md', GLOBAL_MD)
    writeRule(join(root, 'proj', '.c0de', 'rules'), 'p.md', PROJECT_MD)

    const { rules, issues } = discoverStreamRules(join(root, 'proj'))
    expect(issues).toEqual([])
    expect(rules.map((rule) => rule.name)).toEqual(['global-rule'])
  })

  it('同名项目级覆盖全局（按 name 而非文件名）', () => {
    writeRule(join(resolveGlobalConfigDir(), 'rules'), 'a.md', GLOBAL_MD)
    writeRule(
      join(root, 'proj', '.c0de', 'rules'),
      'b.md',
      PROJECT_MD.replace('project-rule', 'global-rule'),
    )

    const { rules } = discoverStreamRules(join(root, 'proj'), { projectTrusted: true })
    expect(rules).toHaveLength(1)
    expect(rules[0]?.source).toBe(join(root, 'proj', '.c0de', 'rules', 'b.md'))
  })

  it('非法文件进 issues（含 source 与原因），合法规则照常返回', () => {
    writeRule(join(resolveGlobalConfigDir(), 'rules'), 'good.md', GLOBAL_MD)
    writeRule(join(resolveGlobalConfigDir(), 'rules'), 'bad.md', '---\ncondition: "[oops"\n---\nb')
    writeRule(join(resolveGlobalConfigDir(), 'rules'), 'ignored.txt', '非 md 不读')

    const { rules, issues } = discoverStreamRules(join(root, 'proj'), { projectTrusted: true })
    expect(rules.map((rule) => rule.name)).toEqual(['global-rule'])
    expect(issues).toHaveLength(1)
    expect(issues[0]?.source).toBe(join(resolveGlobalConfigDir(), 'rules', 'bad.md'))
    expect(issues[0]?.error).toContain('正则非法')
  })

  it('两个规则目录都不存在：空结果', () => {
    const { rules, issues } = discoverStreamRules(join(root, 'nowhere'), { projectTrusted: true })
    expect(rules).toEqual([])
    expect(issues).toEqual([])
  })
})
