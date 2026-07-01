import { describe, expectTypeOf, it } from 'vitest'
import type { Config } from './config.js'
import type {
  AgentConfig,
  AgentDependencies,
  AgentError,
  AgentEvent,
  AgentState,
  AgentStatus,
  ChatTool,
  CommandResult,
  HookRunner,
  LLMSegment,
  PromptContext,
  SlashCommand,
  TokenBudget,
} from './types.js'

describe('core types', () => {
  it('AgentDependencies has all service fields', () => {
    expectTypeOf<AgentDependencies>().toMatchTypeOf<{
      db: unknown
      llmRegistry: unknown
      toolRegistry: unknown
      permission: unknown
      config: Config
      cwd: string
    }>()
  })

  it('PromptContext has required fields', () => {
    expectTypeOf<PromptContext>().toHaveProperty('tools')
    expectTypeOf<PromptContext>().toHaveProperty('config').toEqualTypeOf<AgentConfig>()
    expectTypeOf<PromptContext>().toHaveProperty('projectInfo')
    expectTypeOf<PromptContext>().toHaveProperty('skills')
    expectTypeOf<PromptContext>().toHaveProperty('cwd')
  })

  it('SlashCommand has name and execute', () => {
    const cmd: SlashCommand = {
      name: 'test',
      description: 'd',
      execute: async () => ({ _tag: 'success', message: 'ok' }),
    }
    expectTypeOf(cmd.name).toEqualTypeOf<string>()
  })

  it('re-exports shared agent types', () => {
    expectTypeOf<AgentConfig>().toBeObject()
    expectTypeOf<AgentError>().toBeObject()
    expectTypeOf<AgentEvent>().toBeObject()
    expectTypeOf<AgentState>().toBeObject()
    expectTypeOf<AgentStatus>().toBeObject()
    expectTypeOf<ChatTool>().toBeObject()
    expectTypeOf<LLMSegment>().toBeObject()
    expectTypeOf<TokenBudget>().toBeObject()
  })

  it('CommandResult is a discriminated union', () => {
    expectTypeOf<CommandResult>().toHaveProperty('_tag')
  })

  it('AgentDependencies has optional hookRunner', () => {
    expectTypeOf<AgentDependencies>().toHaveProperty('hookRunner')
  })

  it('re-exports HookRunner type', () => {
    expectTypeOf<HookRunner>().toBeObject()
  })
})
