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
})
