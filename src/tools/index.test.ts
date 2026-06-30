import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../core/config.js'
import type { ToolContext } from '../shared/types/tool.js'
import {
  autoAllowChecker,
  bashTool,
  createDefaultRegistry,
  createPermissionChecker,
  createToolRegistry,
  editTool,
  executeTool,
  getTool,
  globTool,
  globToRegex,
  grepTool,
  listTools,
  readTool,
  registerTool,
  truncateOutput,
  validateInput,
  writeTool,
} from './index.js'

describe('tools index', () => {
  it('exports all framework functions', () => {
    expect(createToolRegistry).toBeDefined()
    expect(registerTool).toBeDefined()
    expect(getTool).toBeDefined()
    expect(listTools).toBeDefined()
    expect(executeTool).toBeDefined()
    expect(validateInput).toBeDefined()
    expect(truncateOutput).toBeDefined()
    expect(createPermissionChecker).toBeDefined()
    expect(autoAllowChecker).toBeDefined()
  })

  it('exports all builtin tools', () => {
    expect(readTool.name).toBe('read')
    expect(writeTool.name).toBe('write')
    expect(editTool.name).toBe('edit')
    expect(globTool.name).toBe('glob')
    expect(grepTool.name).toBe('grep')
    expect(bashTool.name).toBe('bash')
  })

  it('createDefaultRegistry registers all builtin tools', () => {
    const reg = createDefaultRegistry()
    const tools = listTools(reg)
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'bash',
      'debug_breakpoint',
      'debug_continue',
      'debug_eval',
      'debug_stack',
      'debug_start',
      'debug_step',
      'debug_stop',
      'debug_vars',
      'edit',
      'glob',
      'grep',
      'read',
      'task',
      'websearch',
      'write',
    ])
  })

  it('createDefaultRegistry() without config still registers websearch (uses DEFAULT_CONFIG)', () => {
    const reg = createDefaultRegistry()
    expect(getTool(reg, 'websearch')).toBeDefined()
  })

  it('createDefaultRegistry(config) wires websearch from config.websearch', () => {
    const reg = createDefaultRegistry({
      ...DEFAULT_CONFIG,
      websearch: { provider: 'duckduckgo' },
    })
    const tool = getTool(reg, 'websearch')
    expect(tool).toBeDefined()
    expect(tool?.permission).toBe('auto')
  })

  it('can execute read via default registry', async () => {
    const reg = createDefaultRegistry()
    const ctx: ToolContext = {
      cwd: process.cwd(),
      session: { id: 's1', cwd: process.cwd() },
      abort: new AbortController().signal,
    }
    const result = await executeTool(
      reg,
      'glob',
      { pattern: 'package.json' },
      ctx,
      autoAllowChecker,
    )
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('package.json')
    }
  })

  it('exports globToRegex', () => {
    expect(globToRegex('*.ts').test('foo.ts')).toBe(true)
  })
})
