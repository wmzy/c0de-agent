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
  resolveEnabledToolNames,
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
      'kanban',
      'read',
      'task',
      'todo',
      'websearch',
      'write',
      'yield',
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

describe('resolveEnabledToolNames 语义（P1-1：空=无工具 fail-closed）', () => {
  const registry = createDefaultRegistry()

  it('enabled: [] → 无工具（fail-closed，不再是旧版「全部」）', () => {
    expect(resolveEnabledToolNames(registry, { tools: { enabled: [], disabled: [] } })).toEqual([])
  })

  it("enabled: ['*'] → 全部注册工具", () => {
    const all = listTools(registry)
      .map((t) => t.name)
      .sort()
    const resolved = resolveEnabledToolNames(registry, {
      tools: { enabled: ['*'], disabled: [] },
    }).sort()
    expect(resolved).toEqual(all)
  })

  it('enabled: 名单 → 仅返回名单（∩ registered）', () => {
    expect(
      resolveEnabledToolNames(registry, { tools: { enabled: ['read', 'write'], disabled: [] } }),
    ).toEqual(['read', 'write'])
  })

  it('disabled 恒过滤（即使通配 *）', () => {
    const resolved = resolveEnabledToolNames(registry, {
      tools: { enabled: ['*'], disabled: ['bash'] },
    })
    expect(resolved).not.toContain('bash')
    expect(resolved).toContain('read')
  })

  it('explicit 空数组 → 无工具（前端显式全不选）', () => {
    expect(
      resolveEnabledToolNames(registry, { tools: { enabled: ['read'], disabled: [] } }, []),
    ).toEqual([])
  })

  describe('P2 交集语义：explicit 不能扩大 config.tools.enabled 的禁用面', () => {
    it("enabled: ['read'] + explicit ['bash'] → 交集为空（配置是上限）", () => {
      expect(
        resolveEnabledToolNames(registry, { tools: { enabled: ['read'], disabled: [] } }, ['bash']),
      ).toEqual([])
    })

    it("enabled: ['read','bash'] + explicit ['bash','write'] → ['bash']", () => {
      expect(
        resolveEnabledToolNames(registry, { tools: { enabled: ['read', 'bash'], disabled: [] } }, [
          'bash',
          'write',
        ]),
      ).toEqual(['bash'])
    })

    it("enabled: [] + explicit ['bash'] → 空（fail-closed 不可被请求绕过）", () => {
      expect(
        resolveEnabledToolNames(registry, { tools: { enabled: [], disabled: [] } }, ['bash']),
      ).toEqual([])
    })

    it("enabled: ['*'] + explicit ['bash'] → 原样生效（通配无上限）", () => {
      expect(
        resolveEnabledToolNames(registry, { tools: { enabled: ['*'], disabled: [] } }, ['bash']),
      ).toEqual(['bash'])
    })

    it('enabled 未配置 + explicit → 原样生效（未配置视为通配）', () => {
      expect(
        resolveEnabledToolNames(registry, { tools: { enabled: ['*'], disabled: [] } }, ['bash']),
      ).toEqual(['bash'])
      // 未配置 enabled（无 tools 键）同样视为通配
      expect(
        resolveEnabledToolNames(registry, { tools: { disabled: [] } } as never, ['bash']),
      ).toEqual(['bash'])
    })

    it('交集后 disabled 仍恒过滤', () => {
      expect(
        resolveEnabledToolNames(
          registry,
          { tools: { enabled: ['read', 'bash'], disabled: ['bash'] } },
          ['bash', 'read'],
        ),
      ).toEqual(['read'])
    })
  })
})
