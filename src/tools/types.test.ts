import { describe, it, expectTypeOf } from 'vitest'
import type { JSONSchema } from '../shared/types/base.js'
import type {
  ChatTool,
  ToolContext,
  ToolDef,
  ToolExecutor,
  ToolMode,
  ToolPermission,
  ToolResult,
} from '../shared/types/tool.js'
import type {
  PermissionResult,
  PermissionChecker,
  ToolRegistry,
  ToolFactory,
  ToolFactoryContext,
  ValidationResult,
  TruncateOptions,
  TruncateResult,
  BashInput,
  ReadInput,
  WriteInput,
  EditInput,
  GlobInput,
  GrepInput,
  GrepMatch,
} from './types.js'

describe('tool types', () => {
  it('re-exports shared tool types', () => {
    expectTypeOf<ToolDef>().toMatchTypeOf<ToolDef>()
    expectTypeOf<ToolResult>().toMatchTypeOf<ToolResult>()
    expectTypeOf<ToolPermission>().toMatchTypeOf<'auto' | 'ask' | 'deny'>()
    expectTypeOf<ToolContext>().toMatchTypeOf<ToolContext>()
    expectTypeOf<ToolExecutor>().toMatchTypeOf<ToolExecutor>()
    expectTypeOf<ToolMode>().toMatchTypeOf<ToolMode>()
    expectTypeOf<JSONSchema>().toMatchTypeOf<JSONSchema>()
    expectTypeOf<ChatTool>().toMatchTypeOf<ChatTool>()
  })

  it('defines registry types', () => {
    const r: ToolRegistry = { tools: new Map(), factories: new Map() }
    expectTypeOf(r).toMatchTypeOf<ToolRegistry>()

    const f: ToolFactory = (ctx) => null
    expectTypeOf(f).toMatchTypeOf<ToolFactory>()

    const fc: ToolFactoryContext = { config: {}, cwd: '/tmp' }
    expectTypeOf(fc).toMatchTypeOf<ToolFactoryContext>()
  })

  it('defines permission types', () => {
    const allow: PermissionResult = { _tag: 'allow' }
    const deny: PermissionResult = { _tag: 'deny', reason: 'no' }
    const ask: PermissionResult = { _tag: 'ask', reason: 'confirm?', toolCallId: 'tc1' }
    expectTypeOf(allow).toMatchTypeOf<PermissionResult>()
    expectTypeOf(deny).toMatchTypeOf<PermissionResult>()
    expectTypeOf(ask).toMatchTypeOf<PermissionResult>()

    const checker: PermissionChecker = {
      check: async () => allow,
      confirm: () => {},
    }
    expectTypeOf(checker).toMatchTypeOf<PermissionChecker>()
  })

  it('defines validation result type', () => {
    const ok: ValidationResult = { valid: true }
    const err: ValidationResult = { valid: false, error: 'missing field' }
    expectTypeOf(ok).toMatchTypeOf<ValidationResult>()
    expectTypeOf(err).toMatchTypeOf<ValidationResult>()
  })

  it('defines truncation types', () => {
    const opts: TruncateOptions = { maxLines: 100, maxChars: 5000, headLines: 20, tailLines: 20 }
    expectTypeOf(opts).toMatchTypeOf<TruncateOptions>()

    const res: TruncateResult = { output: 'x', truncated: false, totalLines: 1, totalChars: 1 }
    expectTypeOf(res).toMatchTypeOf<TruncateResult>()
  })

  it('defines builtin tool input types', () => {
    const ri: ReadInput = { path: 'foo.ts' }
    const wi: WriteInput = { path: 'foo.ts', content: 'x' }
    const ei: EditInput = { path: 'foo.ts', oldText: 'a', newText: 'b' }
    const gi: GlobInput = { pattern: '**/*.ts', path: '.' }
    const gri: GrepInput = { pattern: 'foo', path: '.' }
    const bi: BashInput = { command: 'ls' }
    expectTypeOf(ri).toMatchTypeOf<ReadInput>()
    expectTypeOf(wi).toMatchTypeOf<WriteInput>()
    expectTypeOf(ei).toMatchTypeOf<EditInput>()
    expectTypeOf(gi).toMatchTypeOf<GlobInput>()
    expectTypeOf(gri).toMatchTypeOf<GrepInput>()
    expectTypeOf(bi).toMatchTypeOf<BashInput>()

    const gm: GrepMatch = { file: 'a.ts', line: 1, text: 'foo', match: 'foo' }
    expectTypeOf(gm).toMatchTypeOf<GrepMatch>()
  })
})
