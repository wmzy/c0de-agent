import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolDef } from '../shared/types/tool.js'
import {
  buildDynamicPrompt,
  createPromptRegistry,
  registerPromptSection,
} from './prompt-registry.js'
import { PROMPT_BODIES } from './prompts.generated.js'
import type { AgentConfig, PromptBuildContext, PromptSection } from './types.js'
import { WORKFLOW_NOTICE, WORKFLOW_SCRIPT_TEMPLATE } from './workflow.js'

const config: AgentConfig = {
  provider: 'openai',
  model: 'gpt-4o',
  tools: ['read'],
  plugins: [],
}

const readTool: ToolDef = {
  name: 'read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  permission: 'auto',
  execute: async () => ({ _tag: 'success', output: '' }),
}

const ctx: PromptBuildContext = {
  tools: [readTool],
  config,
  projectInfo: { name: 'demo', language: 'TypeScript', rootDir: '/repo' },
}

// 覆写层按解析时的 C0DE_CONFIG_DIR 读全局 <config>/prompts——每用例隔离到
// 空 tmp 目录，避免开发机真实 ~/.c0de/prompts 泄入断言（skills.test 同款）。
const prevConfigDir = process.env.C0DE_CONFIG_DIR
const cleanups: string[] = []

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

beforeEach(() => {
  process.env.C0DE_CONFIG_DIR = makeTmp('prompts-global-')
})

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.C0DE_CONFIG_DIR
  else process.env.C0DE_CONFIG_DIR = prevConfigDir
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('PROMPT_BODIES（生成器输出）', () => {
  it('含 src/core/prompts 下全部分片文件（键=文件名去 .md，正文逐字一致）', () => {
    const promptsDir = fileURLToPath(new URL('./prompts', import.meta.url))
    const files = readdirSync(promptsDir)
      .filter((name) => name.endsWith('.md'))
      .sort()
    expect(files.length).toBeGreaterThan(0)
    expect(Object.keys(PROMPT_BODIES).sort()).toEqual(files.map((f) => f.slice(0, -3)))
    for (const name of files) {
      const id = name.slice(0, -3)
      expect(PROMPT_BODIES[id]).toBe(readFileSync(join(promptsDir, name), 'utf8').trimEnd())
    }
  })

  it('静态内置分片 id 全部有非空正文（生成文件与 registry 不漂移）', () => {
    const staticIds = [
      'role',
      'engineering',
      'tool-usage',
      'codebase',
      'constraints',
      'execution-workflow',
      'verification',
      'delivery-contract',
      'git-safety',
      'tone',
    ]
    for (const id of staticIds) {
      expect((PROMPT_BODIES[id] ?? '').length).toBeGreaterThan(0)
    }
  })
})

describe('用户覆写层（.md 文件）', () => {
  function writeOverride(base: string, name: string, body: string): void {
    mkdirSync(join(base, 'prompts'), { recursive: true })
    writeFileSync(join(base, 'prompts', name), body)
  }

  it('全局层：同名文件替换内置分片正文（保留槽位与条件）', () => {
    writeOverride(process.env.C0DE_CONFIG_DIR ?? '', 'tone.md', '# Custom Tone\nBe terse.')
    const out = buildDynamicPrompt(createPromptRegistry(), ctx)
    expect(out).toContain('# Custom Tone\nBe terse.')
    expect(out).not.toContain('# Tone & Output')
  })

  it('全局层：未命中 id 按文件名字典序追加在内置之后，尾部空白被 trim', () => {
    writeOverride(process.env.C0DE_CONFIG_DIR ?? '', 'zzz-extra.md', '# Z Extra')
    writeOverride(process.env.C0DE_CONFIG_DIR ?? '', 'aaa-extra.md', '# A Extra\n\n\n')
    const out = buildDynamicPrompt(createPromptRegistry(), ctx)
    // 追加段位于全部内置段之后（最后一段内置是 workflow-format，priority 121）
    const lastBuiltin = out.indexOf('NEVER create bash/shell scripts for workflows.')
    expect(out.indexOf('# A Extra')).toBeGreaterThan(lastBuiltin)
    // aaa 在 zzz 之前；trim 尾部空白后以 \n\n 与下一分片拼接
    expect(out.slice(out.indexOf('# A Extra')).startsWith('# A Extra\n\n# Z Extra')).toBe(true)
  })

  it('替换含 render 的分片时以静态正文生效（render 被移除）', () => {
    writeOverride(process.env.C0DE_CONFIG_DIR ?? '', 'tool-usage.md', '# My tool rules')
    const out = buildDynamicPrompt(createPromptRegistry(), ctx)
    expect(out).toContain('# My tool rules')
    expect(out).not.toContain('## Available Tools')
    expect(out).not.toContain('**read**')
  })

  it('项目层：仅 projectTrusted 时加载，同名项目文件胜过全局文件', () => {
    writeOverride(process.env.C0DE_CONFIG_DIR ?? '', 'role.md', 'GLOBAL ROLE')
    const cwd = makeTmp('prompts-project-')
    writeOverride(join(cwd, '.c0de'), 'role.md', 'PROJECT ROLE\n')
    writeOverride(join(cwd, '.c0de'), 'proj-only.md', 'PROJECT ONLY')
    // 未信任：项目层不加载（fail-closed），全局层照常生效
    const untrusted = buildDynamicPrompt(createPromptRegistry(), { ...ctx, cwd })
    expect(untrusted).toContain('GLOBAL ROLE')
    expect(untrusted).not.toContain('PROJECT ROLE')
    expect(untrusted).not.toContain('PROJECT ONLY')
    // 信任：项目层生效，且同名胜过全局
    const trusted = buildDynamicPrompt(createPromptRegistry(), {
      ...ctx,
      cwd,
      projectTrusted: true,
    })
    expect(trusted).toContain('PROJECT ROLE')
    expect(trusted).not.toContain('GLOBAL ROLE')
    expect(trusted).toContain('PROJECT ONLY')
  })

  it('目录不存在/为空时静默跳过，输出即内置拼装', () => {
    const out = buildDynamicPrompt(createPromptRegistry(), ctx)
    expect(out).toContain('c0de-agent')
    expect(out).toContain('# Tone & Output')
  })
})

describe('createPromptRegistry / builtin sections', () => {
  it('ships the core builtin section ids', () => {
    const reg = createPromptRegistry()
    const ids = Array.from(reg.sections.keys())
    for (const id of ['role', 'engineering', 'tool-usage', 'codebase', 'constraints', 'project']) {
      expect(ids).toContain(id)
    }
  })

  it('renders the role + project sections in a built prompt', () => {
    const reg = createPromptRegistry()
    const out = buildDynamicPrompt(reg, ctx)
    expect(out).toContain('c0de-agent')
    expect(out).toContain('demo')
    expect(out).toContain('TypeScript')
  })

  it('lists enabled tools via the dynamic tool-usage section', () => {
    const reg = createPromptRegistry()
    const out = buildDynamicPrompt(reg, ctx)
    expect(out).toContain('**read**')
  })

  it('omits the tool-usage section when there are no tools', () => {
    const reg = createPromptRegistry()
    const out = buildDynamicPrompt(reg, { ...ctx, tools: [] })
    expect(out).not.toContain('**read**')
  })

  it('slash-commands section 始终列出内置命令', () => {
    const reg = createPromptRegistry()
    const out = buildDynamicPrompt(reg, ctx)
    expect(out).toContain('## Slash Commands')
    expect(out).toContain('/help')
    expect(out).toContain('/compact')
  })

  it('agents section 仅在有 agents 时出现', () => {
    const reg = createPromptRegistry()
    expect(buildDynamicPrompt(reg, { ...ctx, agents: ['coder'] })).toContain('## Available Agents')
    expect(buildDynamicPrompt(reg, { ...ctx, agents: ['coder'] })).toContain('coder')
    // 无 agents 时不出现
    expect(buildDynamicPrompt(reg, ctx)).not.toContain('## Available Agents')
  })

  // 回归：常驻 workflow-format section 与 workflowz steering 通告（WORKFLOW_NOTICE）
  // 会同时进 system prompt——js 骨架必须出自同一常量，两份手抄副本曾各自漂移
  // （常驻版 meta 缺 argsHint/timeout、ctx 示例不同），模型按任一生成都被判合法。
  it('workflow-format section 与 WORKFLOW_NOTICE 的 js 模板同源', () => {
    const reg = createPromptRegistry()
    const out = buildDynamicPrompt(reg, ctx)
    const fenced = `\`\`\`js\n${WORKFLOW_SCRIPT_TEMPLATE}\n\`\`\``
    expect(out).toContain(fenced)
    expect(WORKFLOW_NOTICE).toContain(fenced)
  })
})

describe('registerPromptSection (plugin extensibility)', () => {
  it('appends a custom section into the rendered prompt', () => {
    const reg = createPromptRegistry()
    const custom: PromptSection = {
      id: 'house-rules',
      content: '# House Rules\nNever commit to main.',
      priority: 100,
    }
    registerPromptSection(reg, custom)
    const out = buildDynamicPrompt(reg, ctx)
    expect(out).toContain('Never commit to main.')
  })

  it('a later registration with the same id overrides the builtin', () => {
    const reg = createPromptRegistry()
    registerPromptSection(reg, {
      id: 'role',
      content: 'OVERRIDDEN ROLE',
      priority: 0,
    })
    const out = buildDynamicPrompt(reg, ctx)
    expect(out).toContain('OVERRIDDEN ROLE')
  })

  it('condition=false hides a section', () => {
    const reg = createPromptRegistry()
    registerPromptSection(reg, {
      id: 'cond',
      content: 'SHOULD BE HIDDEN',
      priority: 50,
      condition: () => false,
    })
    const out = buildDynamicPrompt(reg, ctx)
    expect(out).not.toContain('SHOULD BE HIDDEN')
  })

  it('render function overrides static content and receives ctx', () => {
    const reg = createPromptRegistry()
    registerPromptSection(reg, {
      id: 'dyn',
      content: 'STATIC',
      priority: 60,
      render: (c) => `DYNAMIC agent count=${c.agents?.length ?? 0}`,
    })
    const out = buildDynamicPrompt(reg, { ...ctx, agents: ['a', 'b'] })
    expect(out).toContain('DYNAMIC agent count=2')
    expect(out).not.toContain('STATIC')
  })

  it('respects priority ordering (lower sorts earlier)', () => {
    const reg = createPromptRegistry()
    // Clear builtins to make ordering deterministic.
    reg.sections.clear()
    registerPromptSection(reg, { id: 'late', content: 'ZZZ', priority: 90 })
    registerPromptSection(reg, { id: 'early', content: 'AAA', priority: 10 })
    const out = buildDynamicPrompt(reg, ctx)
    expect(out.indexOf('AAA')).toBeLessThan(out.indexOf('ZZZ'))
  })
})
