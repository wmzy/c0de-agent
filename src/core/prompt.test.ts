import { describe, expect, it } from 'vitest'
import type { AgentConfig } from '../shared/types/agent.js'
import type { ToolDef } from '../shared/types/tool.js'
import { buildSystemPrompt } from './prompt.js'

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

describe('buildSystemPrompt', () => {
  it('includes the role description', () => {
    const prompt = buildSystemPrompt({
      tools: [readTool],
      config,
      projectInfo: { name: 'myapp', language: 'TypeScript', rootDir: '/proj' },
    })
    expect(prompt).toContain('c0de-agent')
    expect(prompt).toContain('coding assistant')
  })

  it('lists enabled tools with descriptions', () => {
    const prompt = buildSystemPrompt({
      tools: [readTool],
      config,
      projectInfo: { name: 'myapp', language: 'TypeScript', rootDir: '/proj' },
    })
    expect(prompt).toContain('read')
    expect(prompt).toContain('Read a file')
  })

  it('includes tool usage guidance preferring dedicated tools over shell commands', () => {
    const prompt = buildSystemPrompt({
      tools: [readTool],
      config,
      projectInfo: { name: 'myapp', language: 'TypeScript', rootDir: '/proj' },
    })
    expect(prompt).toContain('glob')
    expect(prompt).toMatch(/NOT.*find/i)
    expect(prompt).toMatch(/NOT.*cat/i)
    // file_path:line 引用约定
    expect(prompt).toMatch(/file_path.*line/)
  })

  it('includes project info', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'myapp', language: 'TypeScript', framework: 'React', rootDir: '/proj' },
    })
    expect(prompt).toContain('myapp')
    expect(prompt).toContain('TypeScript')
    expect(prompt).toContain('React')
  })

  it('includes paradigm constraints', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/data\s*\+\s*functions/i)
  })

  it('includes skills when provided', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
      skills: ['brainstorming'],
    })
    expect(prompt).toContain('brainstorming')
  })

  it('includes custom systemPrompt when set', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config: { ...config, systemPrompt: 'You are a SQL expert.' },
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toContain('SQL expert')
  })

  // ===== 本次新增段覆盖 =====

  it('includes engineering principles', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/correctness first/i)
    expect(prompt).toMatch(/allocate avoidably/i)
  })

  it('includes working-with-codebase guidance', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/package\.json/i)
    expect(prompt).toMatch(/never assume.*library/i)
  })

  it('includes execution workflow', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/execution workflow/i)
    expect(prompt).toMatch(/verify/i)
  })

  it('includes verification & evidence requirements', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/without proof/i)
    expect(prompt).toContain('[INFERENCE]')
  })

  it('includes delivery contract', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/clean cutover/i)
    expect(prompt).toMatch(/stub|placeholder|mock/i)
  })

  it('includes git safety rules', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/NEVER commit/i)
    expect(prompt).toMatch(/reset --hard/i)
  })

  it('includes tone & output guidance', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/concise/i)
    expect(prompt).toMatch(/preamble/i)
  })
})
