import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearContextFilesCache,
  closeOpenFence,
  discoverContextFiles,
  expandAtImports,
  renderContextFilesSection,
} from './context-files.js'

let root: string

const write = (rel: string, content: string): string => {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctx-files-'))
  clearContextFilesCache()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  clearContextFilesCache()
})

describe('层级注入：AGENTS.md / CLAUDE.md', () => {
  it('cwd 与仓库根各层都收集，近 cwd 在前', () => {
    mkdirSync(join(root, '.git'), { recursive: true })
    write('AGENTS.md', '# root agents')
    mkdirSync(join(root, 'apps', 'web'), { recursive: true })
    write('apps/web/AGENTS.md', '# web agents')
    const bundle = discoverContextFiles(join(root, 'apps', 'web'))
    expect(bundle.files.map((f) => f.content)).toEqual(['# web agents', '# root agents'])
    // 层级文件不给子 agent
    expect(bundle.files.every((f) => !f.forSubagents)).toBe(true)
  })

  it('同层 AGENTS.md 优先于 CLAUDE.md；空文件不占槽', () => {
    mkdirSync(join(root, '.git'), { recursive: true })
    write('AGENTS.md', '')
    write('CLAUDE.md', '# claude')
    const bundle = discoverContextFiles(root)
    expect(bundle.files).toHaveLength(1)
    expect(bundle.files[0]?.content).toBe('# claude')
  })

  it('无 .git 时只看 cwd 一层（不越界到父目录）', () => {
    write('AGENTS.md', '# outer')
    const inner = join(root, 'inner')
    mkdirSync(inner, { recursive: true })
    write('inner/AGENTS.md', '# inner')
    const bundle = discoverContextFiles(inner)
    expect(bundle.files.map((f) => f.content)).toEqual(['# inner'])
  })
})

describe('cwd 层附加格式', () => {
  it('copilot-instructions / .cursorrules / .clinerules 目录', () => {
    write('.github/copilot-instructions.md', '# copilot')
    write('.cursorrules', '# legacy cursor')
    write('.clinerules/a.md', '# cline a')
    write('.clinerules/b.md', '# cline b')
    const contents = discoverContextFiles(root).files.map((f) => f.content)
    expect(contents).toContain('# copilot')
    expect(contents).toContain('# legacy cursor')
    expect(contents).toContain('# cline a')
    expect(contents).toContain('# cline b')
  })

  it('cursor 规则按 frontmatter 门控：alwaysApply 注入、globs 只列目录、无标记跳过', () => {
    write(
      '.cursor/rules/always.mdc',
      '---\ndescription: ts rules\nalwaysApply: true\n---\n# always body',
    )
    write(
      '.cursor/rules/tests.md',
      '---\ndescription: test rules\nglobs: ["**/*.test.ts"]\n---\n# test body',
    )
    write('.cursor/rules/dormant.md', '# no frontmatter body')
    const bundle = discoverContextFiles(root)
    expect(bundle.files.map((f) => f.content)).toContain('# always body')
    expect(bundle.files.map((f) => f.content)).not.toContain('# test body')
    expect(bundle.domainRules).toEqual([
      { name: 'tests', globs: '**/*.test.ts', description: 'test rules' },
    ])
    expect(bundle.files.map((f) => f.path)).not.toContain(join(root, '.cursor/rules/dormant.md'))
  })

  it('windsurf 规则认 trigger_always / trigger_glob', () => {
    write('.windsurf/rules/a.md', '---\ntrigger_always: true\n---\n# ws always')
    write('.windsurf/rules/b.md', '---\ntrigger_glob: "**/*.go"\ndescription: go\n---\nbody')
    const bundle = discoverContextFiles(root)
    expect(bundle.files.map((f) => f.content)).toContain('# ws always')
    expect(bundle.domainRules).toEqual([{ name: 'b', globs: '**/*.go', description: 'go' }])
  })
})

describe('extra 文件名', () => {
  it('逐级向上收集（additive），拒绝路径与保留名', () => {
    mkdirSync(join(root, '.git'), { recursive: true })
    write('TEAM.md', '# team root')
    const sub = join(root, 'pkg')
    mkdirSync(sub, { recursive: true })
    const bundle = discoverContextFiles(sub, { extra: ['TEAM.md', 'a/b.md', 'AGENTS.md'] })
    const contents = bundle.files.map((f) => f.content)
    expect(contents).toContain('# team root')
    expect(bundle.files).toHaveLength(1)
    expect(bundle.files[0]?.forSubagents).toBe(true)
  })
})

describe('@import 展开', () => {
  it('相对路径展开 + 环与缺失文件保留原 token', () => {
    const importing = write('docs/main.md', 'see @./part.md and @./missing.md')
    write('docs/part.md', 'part body @./part.md')
    const out = expandAtImports('see @./part.md and @./missing.md', importing)
    expect(out).toBe('see part body @./part.md and @./missing.md')
  })

  it('围栏与行内代码内的 @ 不展开', () => {
    write('docs/target.md', 'TARGET')
    const file = write('docs/x.md', 'x')
    const tick = String.fromCharCode(96)
    const text = `${tick}@./target.md${tick}\n\n${tick}${tick}${tick}\n@./target.md\n${tick}${tick}${tick}\n\nok @./target.md`
    const expected = `${tick}@./target.md${tick}\n\n${tick}${tick}${tick}\n@./target.md\n${tick}${tick}${tick}\n\nok TARGET`
    expect(expandAtImports(text, file)).toBe(expected)
  })

  it('总次数封顶（防展开炸弹）', () => {
    write('docs/a.md', '@./a.md')
    let out = ''
    for (let i = 0; i < 300; i++) out += '@./a.md\n'
    const file = join(root, 'docs', 'many.md')
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(file, out)
    // 不断言精确次数（实现细节），只断言不抛错且行数不变（行尾 \n 会多一个空元素）
    const expanded = expandAtImports(out, file)
    expect(expanded.trimEnd().split('\n')).toHaveLength(300)
  })
})

describe('深目录指针与渲染', () => {
  it('更深处的 AGENTS.md 只列指针不注入正文', () => {
    write('AGENTS.md', '# root')
    write('packages/a/AGENTS.md', '# deep rules')
    const bundle = discoverContextFiles(root)
    expect(bundle.files).toHaveLength(1)
    expect(bundle.deepAgentsMd).toEqual([
      { path: join(root, 'packages/a/AGENTS.md'), dir: join(root, 'packages/a') },
    ])
    const section = renderContextFilesSection(bundle)
    expect(section).toContain('<repo-rules>')
    expect(section).toContain('packages/a/AGENTS.md')
    expect(section).not.toContain('# deep rules')
  })

  it('未闭合围栏补闭合', () => {
    expect(closeOpenFence('```\ncode')).toBe('```\ncode\n```')
    expect(closeOpenFence('```\ncode\n```')).toBe('```\ncode\n```')
  })

  it('空 bundle 渲染为空串（section 被 condition 剔除）', () => {
    expect(renderContextFilesSection({ files: [], domainRules: [], deepAgentsMd: [] })).toBe('')
  })
})

describe('开关与缓存', () => {
  it('enabled:false 返回空 bundle', () => {
    write('AGENTS.md', '# x')
    expect(discoverContextFiles(root, { enabled: false })).toEqual({
      files: [],
      domainRules: [],
      deepAgentsMd: [],
    })
  })

  it('TTL 内命中缓存；清缓存后重新发现', () => {
    write('AGENTS.md', '# v1')
    expect(discoverContextFiles(root).files[0]?.content).toBe('# v1')
    write('AGENTS.md', '# v2')
    expect(discoverContextFiles(root).files[0]?.content).toBe('# v1')
    clearContextFilesCache()
    expect(discoverContextFiles(root).files[0]?.content).toBe('# v2')
  })
})
