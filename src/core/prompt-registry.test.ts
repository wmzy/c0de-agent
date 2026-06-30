import { describe, expect, it } from 'vitest'
import type { ToolDef } from '../shared/types/tool.js'
import {
  buildDynamicPrompt,
  createPromptRegistry,
  registerPromptSection,
} from './prompt-registry.js'
import type { AgentConfig, PromptBuildContext, PromptSection } from './types.js'

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
