# Tools System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tools framework (registry, executor, validation, truncation, permission) and six essential built-in tools (read, write, edit, glob, grep, bash) that give the Core Agent Loop a functional toolset.

**Architecture:** Pure data+functions — no classes, context-first args. The tools package depends only on `shared` types and Node built-ins (`fs`, `path`, `child_process`). No external runtime dependencies (no ajv, no fast-glob, no minimatch — all implemented from scratch). The executor pipeline is: find tool → validate input → check permission → execute → truncate output.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest, Node 22 built-in modules.

---

## Conventions (CRITICAL — re-read before every task)

- **No semicolons**, **single quotes** (Biome enforced).
- `type` not `interface`. `_tag` discriminated unions. `export function` with context-first arg.
- All imports use `.js` extensions. All type-only imports use `import type`.
- `verbatimModuleSyntax: true` — never mix `import { X }` (value) with `import type { Y }` in a single statement; use two separate import lines.
- `strict: true`, `noUncheckedIndexedAccess: true` — array access returns `T | undefined`.
- Shared types already exist in `src/shared/types/tool.ts`: `ToolDef`, `ToolResult`, `ToolPermission`, `ToolContext`, `ToolExecutor`, `ToolMode`. In `src/shared/types/base.ts`: `JSONSchema`, `SessionRef`, `MessageRole`. In `src/shared/types/llm.ts`: `ChatTool`. **DO NOT redefine these.** Import and re-export them.
- **Import source traps**: `MessageRole` is in `../shared/types/base.js`. `ChatTool` is in `../shared/types/llm.js`. `JSONSchema` is in `../shared/types/base.js`.
- Test files: `src/tools/<file>.test.ts` (co-located). Chinese file names NOT used in this project — use English.
- Run tests: `pnpm test src/tools/` for a single directory. `pnpm test` for full suite.
- Run typecheck: `pnpm typecheck`.
- Run lint: `pnpm biome check src/tools/ --write`.

## File Structure

```
src/tools/
├── types.ts           local tool-system types (registry, factory, validation, truncation) + re-exports
├── validate.ts        JSON Schema validation (lightweight, no ajv)
├── truncate.ts        output truncation (head/tail with marker)
├── registry.ts        tool registry (Map-based, factory support)
├── permission.ts      permission checker (auto/ask/deny)
├── executor.ts        executeTool pipeline (find→validate→permission→execute→truncate)
├── builtin/
│   ├── read.ts        file reading (line ranges, binary detection)
│   ├── write.ts       file create/overwrite
│   ├── edit.ts        search/replace diff editing
│   ├── glob.ts        file globbing (glob→regex, recursive walk)
│   ├── grep.ts        content search (regex, recursive)
│   └── bash.ts        shell execution (sync, process tree kill, output capture)
├── index.ts           barrel export + createDefaultRegistry()
└── *.test.ts          co-located tests
```

**Dependency graph (no cycles):**
```
index.ts → executor.ts → { registry.ts, validate.ts, truncate.ts, permission.ts }
                        → builtin/*.ts → (shared types only)
types.ts → re-exports shared types + local registry/factory types
```

---

## Task 1: Local Tool-System Types

**Files:**
- Create: `src/tools/types.ts`
- Test: `src/tools/types.test.ts`

### Step 1: Write the failing test

- [ ] **Create `src/tools/types.test.ts`:**

```typescript
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
```

### Step 2: Run test to verify it fails

- [ ] Run: `pnpm test src/tools/types.test.ts`
- Expected: FAIL — `Cannot find module './types.js'`

### Step 3: Write minimal implementation

- [ ] **Create `src/tools/types.ts`:**

```typescript
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

// ── Registry types ──────────────────────────────────────────

/** Mutable tool registry. Stores both eager tool definitions and lazy factories. */
type ToolRegistry = {
  tools: Map<string, ToolDef>
  factories: Map<string, ToolFactory>
}

/** Context passed to tool factories for lazy tool construction. */
type ToolFactoryContext = {
  config: Record<string, unknown>
  cwd: string
}

/** Factory function for lazy tool loading. Returns null if tool is unavailable. */
type ToolFactory = (ctx: ToolFactoryContext) => ToolDef | null

// ── Permission types ────────────────────────────────────────

/** Result of a permission check. */
type PermissionResult =
  | { _tag: 'allow' }
  | { _tag: 'deny'; reason: string }
  | { _tag: 'ask'; reason: string; toolCallId: string }

/** Permission checker interface. The executor calls `check` before running a tool. */
type PermissionChecker = {
  check: (tool: ToolDef, input: unknown, ctx: ToolContext) => Promise<PermissionResult>
  confirm: (toolCallId: string, approved: boolean) => void
}

// ── Validation types ────────────────────────────────────────

/** Result of JSON Schema validation. */
type ValidationResult =
  | { valid: true }
  | { valid: false; error: string }

// ── Truncation types ────────────────────────────────────────

/** Options for output truncation. */
type TruncateOptions = {
  maxLines: number
  maxChars: number
  headLines: number
  tailLines: number
}

/** Result of output truncation. */
type TruncateResult = {
  output: string
  truncated: boolean
  totalLines: number
  totalChars: number
}

// ── Builtin tool input types ────────────────────────────────

/** Input for the read tool. */
type ReadInput = {
  path: string
  offset?: number
  limit?: number
}

/** Input for the write tool. */
type WriteInput = {
  path: string
  content: string
}

/** Input for the edit tool (search/replace diff mode). */
type EditInput = {
  path: string
  oldText: string
  newText: string
}

/** Input for the glob tool. */
type GlobInput = {
  pattern: string
  path?: string
}

/** Input for the grep tool. */
type GrepInput = {
  pattern: string
  path?: string
  caseSensitive?: boolean
  maxResults?: number
}

/** Input for the bash tool (sync mode). */
type BashInput = {
  command: string
  cwd?: string
  timeout?: number
  env?: Record<string, string>
}

/** A single grep match. */
type GrepMatch = {
  file: string
  line: number
  text: string
  match: string
}

// ── Re-exports ──────────────────────────────────────────────

export type {
  ChatTool,
  JSONSchema,
  PermissionChecker,
  PermissionResult,
  ReadInput,
  ToolContext,
  ToolDef,
  ToolExecutor,
  ToolFactory,
  ToolFactoryContext,
  ToolMode,
  ToolPermission,
  ToolRegistry,
  ToolResult,
  ValidationResult,
}
export type {
  BashInput,
  EditInput,
  GlobInput,
  GrepInput,
  GrepMatch,
  TruncateOptions,
  TruncateResult,
  WriteInput,
}
```

### Step 4: Run test to verify it passes

- [ ] Run: `pnpm test src/tools/types.test.ts`
- Expected: PASS

### Step 5: Commit

- [ ] Run: `git add src/tools/types.ts src/tools/types.test.ts && git commit -m "feat(tools): add local tool-system types"`

---

## Task 2: JSON Schema Validation

**Files:**
- Create: `src/tools/validate.ts`
- Test: `src/tools/validate.test.ts`

### Step 1: Write the failing test

- [ ] **Create `src/tools/validate.test.ts`:**

```typescript
import { describe, it, expect } from 'vitest'
import type { JSONSchema } from '../shared/types/base.js'
import { validateInput } from './validate.js'

describe('validateInput', () => {
  it('validates a simple object schema', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['path'],
    }
    expect(validateInput(schema, { path: 'foo.ts' })).toEqual({ valid: true })
    expect(validateInput(schema, { path: 'foo.ts', limit: 10 })).toEqual({ valid: true })
  })

  it('reports missing required fields', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    const result = validateInput(schema, {})
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain('path')
    }
  })

  it('reports wrong type', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    const result = validateInput(schema, { path: 123 })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain('path')
      expect(result.error).toContain('string')
    }
  })

  it('validates integer type', () => {
    const schema: JSONSchema = { type: 'integer' }
    expect(validateInput(schema, 42)).toEqual({ valid: true })
    expect(validateInput(schema, 3.14).valid).toBe(false)
    expect(validateInput(schema, '42').valid).toBe(false)
  })

  it('validates boolean type', () => {
    const schema: JSONSchema = { type: 'boolean' }
    expect(validateInput(schema, true)).toEqual({ valid: true })
    expect(validateInput(schema, false)).toEqual({ valid: true })
    expect(validateInput(schema, 'true').valid).toBe(false)
  })

  it('validates array type with items', () => {
    const schema: JSONSchema = {
      type: 'array',
      items: { type: 'string' },
    }
    expect(validateInput(schema, ['a', 'b'])).toEqual({ valid: true })
    expect(validateInput(schema, ['a', 1]).valid).toBe(false)
  })

  it('validates enum values', () => {
    const schema: JSONSchema = { type: 'string', enum: ['auto', 'ask', 'deny'] }
    expect(validateInput(schema, 'auto')).toEqual({ valid: true })
    expect(validateInput(schema, 'maybe').valid).toBe(false)
  })

  it('validates anyOf schemas', () => {
    const schema: JSONSchema = {
      anyOf: [{ type: 'string' }, { type: 'number' }],
    }
    expect(validateInput(schema, 'hello')).toEqual({ valid: true })
    expect(validateInput(schema, 42)).toEqual({ valid: true })
    expect(validateInput(schema, true).valid).toBe(false)
  })

  it('reports additionalProperties when false', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    }
    expect(validateInput(schema, { a: 'x' })).toEqual({ valid: true })
    expect(validateInput(schema, { a: 'x', b: 1 }).valid).toBe(false)
  })

  it('accepts null input for nullable schemas', () => {
    const schema: JSONSchema = { type: 'null' }
    expect(validateInput(schema, null)).toEqual({ valid: true })
    expect(validateInput(schema, 'x').valid).toBe(false)
  })

  it('handles nested objects', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: { inner: { type: 'string' } },
          required: ['inner'],
        },
      },
      required: ['outer'],
    }
    expect(validateInput(schema, { outer: { inner: 'val' } })).toEqual({ valid: true })
    expect(validateInput(schema, { outer: {} }).valid).toBe(false)
  })

  it('returns valid for empty schema', () => {
    expect(validateInput({}, { anything: true })).toEqual({ valid: true })
    expect(validateInput({}, 'anything')).toEqual({ valid: true })
  })
})
```

### Step 2: Run test to verify it fails

- [ ] Run: `pnpm test src/tools/validate.test.ts`
- Expected: FAIL — `Cannot find module './validate.js'`

### Step 3: Write minimal implementation

- [ ] **Create `src/tools/validate.ts`:**

```typescript
import type { JSONSchema } from '../shared/types/base.js'
import type { ValidationResult } from './types.js'

/**
 * Validate a value against a JSON Schema (draft-07 subset).
 * Supports: type, required, properties, items, enum, additionalProperties, anyOf, oneOf.
 * No external dependency — lightweight custom implementation.
 */
export function validateInput(schema: JSONSchema, value: unknown): ValidationResult {
  const error = validateNode(schema, value, '')
  if (error) return { valid: false, error }
  return { valid: true }
}

function validateNode(schema: JSONSchema, value: unknown, path: string): string | null {
  // Empty schema accepts anything
  if (Object.keys(schema).length === 0) return null

  // anyOf: at least one must pass
  if (schema.anyOf) {
    const passed = schema.anyOf.some((s) => validateNode(s, value, path) === null)
    if (!passed) return `${path || 'value'}: does not match anyOf schemas`
    return null
  }

  // oneOf: exactly one must pass
  if (schema.oneOf) {
    const count = schema.oneOf.filter((s) => validateNode(s, value, path) === null).length
    if (count !== 1) return `${path || 'value'}: must match exactly one oneOf schema (matched ${count})`
    return null
  }

  // enum
  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value)) {
      return `${path || 'value'}: must be one of ${JSON.stringify(schema.enum)}`
    }
  }

  // type check
  if (schema.type) {
    const typeError = checkType(schema.type, value, path)
    if (typeError) return typeError
  }

  // object validation
  if (schema.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>

    // required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in obj)) {
          return `${path ? path + '.' : ''}${field}: missing required field`
        }
      }
    }

    // properties
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          const err = validateNode(propSchema, obj[key], path ? `${path}.${key}` : key)
          if (err) return err
        }
      }
    }

    // additionalProperties
    if (schema.additionalProperties === false && schema.properties) {
      const knownKeys = new Set(Object.keys(schema.properties))
      for (const key of Object.keys(obj)) {
        if (!knownKeys.has(key)) {
          return `${path ? path + '.' : ''}${key}: additional property not allowed`
        }
      }
    }
  }

  // array validation
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.items) {
      const itemSchema = Array.isArray(schema.items) ? schema.items : [schema.items]
      for (let i = 0; i < value.length; i++) {
        const s = itemSchema[i] ?? itemSchema[0]
        if (s) {
          const err = validateNode(s, value[i], `${path}[${i}]`)
          if (err) return err
        }
      }
    }
  }

  return null
}

function checkType(type: string, value: unknown, path: string): string | null {
  const label = path || 'value'
  switch (type) {
    case 'string':
      if (typeof value !== 'string') return `${label}: expected string, got ${typeof value}`
      break
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return `${label}: expected number, got ${typeof value}`
      }
      break
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return `${label}: expected integer, got ${typeof value}`
      }
      break
    case 'boolean':
      if (typeof value !== 'boolean') return `${label}: expected boolean, got ${typeof value}`
      break
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `${label}: expected object`
      }
      break
    case 'array':
      if (!Array.isArray(value)) return `${label}: expected array, got ${typeof value}`
      break
    case 'null':
      if (value !== null) return `${label}: expected null, got ${typeof value}`
      break
    default:
      break
  }
  return null
}
```

### Step 4: Run test to verify it passes

- [ ] Run: `pnpm test src/tools/validate.test.ts`
- Expected: PASS (all 13 tests)

### Step 5: Commit

- [ ] Run: `git add src/tools/validate.ts src/tools/validate.test.ts && git commit -m "feat(tools): add JSON Schema validation"`

---

## Task 3: Output Truncation

**Files:**
- Create: `src/tools/truncate.ts`
- Test: `src/tools/truncate.test.ts`

### Step 1: Write the failing test

- [ ] **Create `src/tools/truncate.test.ts`:**

```typescript
import { describe, it, expect } from 'vitest'
import { truncateOutput, DEFAULT_TRUNCATE_OPTIONS } from './truncate.js'

describe('truncateOutput', () => {
  it('returns short output unchanged', () => {
    const result = truncateOutput('hello\nworld')
    expect(result.truncated).toBe(false)
    expect(result.output).toBe('hello\nworld')
    expect(result.totalLines).toBe(2)
    expect(result.totalChars).toBe(11)
  })

  it('truncates by maxLines keeping head and tail', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    const result = truncateOutput(lines.join('\n'), {
      ...DEFAULT_TRUNCATE_OPTIONS,
      maxLines: 30,
      headLines: 10,
      tailLines: 10,
    })
    expect(result.truncated).toBe(true)
    expect(result.totalLines).toBe(100)
    // head 10 + marker line + tail 10 = 21 lines
    const outLines = result.output.split('\n')
    expect(outLines.length).toBe(21)
    expect(outLines[0]).toBe('line 0')
    expect(outLines[9]).toBe('line 9')
    expect(outLines[10]).toContain('truncated')
    expect(outLines[11]).toBe('line 90')
    expect(outLines[20]).toBe('line 99')
  })

  it('truncates by maxChars', () => {
    const long = 'x'.repeat(500)
    const result = truncateOutput(long, {
      ...DEFAULT_TRUNCATE_OPTIONS,
      maxLines: 10000,
      maxChars: 100,
      headLines: 30,
      tailLines: 30,
    })
    expect(result.truncated).toBe(true)
    expect(result.output.length).toBeLessThan(long.length)
    expect(result.output).toContain('truncated')
  })

  it('does not truncate when under all limits', () => {
    const result = truncateOutput('short', {
      maxLines: 100,
      maxChars: 1000,
      headLines: 10,
      tailLines: 10,
    })
    expect(result.truncated).toBe(false)
    expect(result.output).toBe('short')
  })

  it('handles empty output', () => {
    const result = truncateOutput('')
    expect(result.truncated).toBe(false)
    expect(result.output).toBe('')
    expect(result.totalLines).toBe(0)
    expect(result.totalChars).toBe(0)
  })

  it('head-only truncation when tail exceeds available lines', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line ${i}`)
    const result = truncateOutput(lines.join('\n'), {
      maxLines: 5,
      maxChars: 10000,
      headLines: 5,
      tailLines: 10,
    })
    // 15 lines, head 5, but tail 10 would overlap → just keep first 5
    expect(result.truncated).toBe(true)
    const outLines = result.output.split('\n')
    expect(outLines.length).toBeLessThanOrEqual(6)
  })

  it('counts lines correctly for string without trailing newline', () => {
    const result = truncateOutput('a\nb\nc')
    expect(result.totalLines).toBe(3)
  })
})
```

### Step 2: Run test to verify it fails

- [ ] Run: `pnpm test src/tools/truncate.test.ts`
- Expected: FAIL — `Cannot find module './truncate.js'`

### Step 3: Write minimal implementation

- [ ] **Create `src/tools/truncate.ts`:**

```typescript
import type { TruncateOptions, TruncateResult } from './types.js'

/** Default truncation thresholds — tuned for LLM context windows. */
export const DEFAULT_TRUNCATE_OPTIONS: TruncateOptions = {
  maxLines: 2000,
  maxChars: 100_000,
  headLines: 50,
  tailLines: 50,
}

/**
 * Truncate output to fit within line and character limits.
 * Preserves head and tail, inserting a marker for omitted content.
 */
export function truncateOutput(
  output: string,
  opts: TruncateOptions = DEFAULT_TRUNCATE_OPTIONS,
): TruncateResult {
  if (output === '') {
    return { output: '', truncated: false, totalLines: 0, totalChars: 0 }
  }

  const lines = output.split('\n')
  const totalLines = lines.length
  const totalChars = output.length

  // Check if truncation is needed
  const needsLineTrunc = totalLines > opts.maxLines
  const needsCharTrunc = totalChars > opts.maxChars

  if (!needsLineTrunc && !needsCharTrunc) {
    return { output, truncated: false, totalLines, totalChars }
  }

  // Line-based truncation takes priority
  if (needsLineTrunc) {
    const head = lines.slice(0, opts.headLines)
    const tail = lines.slice(Math.max(opts.headLines, totalLines - opts.tailLines))
    const omitted = totalLines - head.length - tail.length
    const marker = `[... ${omitted} lines truncated ...]`
    const result = [...head, marker, ...tail].join('\n')
    return { output: result, truncated: true, totalLines, totalChars }
  }

  // Char-based truncation (keep proportional head/tail of chars)
  const keepChars = opts.maxChars
  const headChars = Math.floor(keepChars * 0.5)
  const tailChars = keepChars - headChars
  const head = output.slice(0, headChars)
  const tail = output.slice(totalChars - tailChars)
  const omitted = totalChars - keepChars
  const marker = `\n[... ${omitted} chars truncated ...]\n`
  return { output: head + marker + tail, truncated: true, totalLines, totalChars }
}
```

### Step 4: Run test to verify it passes

- [ ] Run: `pnpm test src/tools/truncate.test.ts`
- Expected: PASS (all 7 tests)

### Step 5: Commit

- [ ] Run: `git add src/tools/truncate.ts src/tools/truncate.test.ts && git commit -m "feat(tools): add output truncation"`

---

## Task 4: Tool Registry

**Files:**
- Create: `src/tools/registry.ts`
- Test: `src/tools/registry.test.ts`

### Step 1: Write the failing test

- [ ] **Create `src/tools/registry.test.ts`:**

```typescript
import { describe, it, expect } from 'vitest'
import type { ToolDef } from '../shared/types/tool.js'
import {
  createToolRegistry,
  registerTool,
  registerToolFactory,
  getTool,
  listTools,
  getToolSchemas,
} from './registry.js'

function makeTool(name: string): ToolDef {
  return {
    name,
    description: `Tool ${name}`,
    parameters: {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
    },
    permission: 'auto',
    execute: async () => ({ _tag: 'success', output: 'ok' }),
  }
}

describe('tool registry', () => {
  it('creates an empty registry', () => {
    const reg = createToolRegistry()
    expect(listTools(reg)).toEqual([])
    expect(getTool(reg, 'x')).toBeUndefined()
  })

  it('registers and retrieves a tool', () => {
    const reg = createToolRegistry()
    registerTool(reg, makeTool('read'))
    expect(getTool(reg, 'read')?.name).toBe('read')
    expect(listTools(reg).map((t) => t.name)).toEqual(['read'])
  })

  it('overwrites a tool with the same name', () => {
    const reg = createToolRegistry()
    registerTool(reg, makeTool('read'))
    const v2 = makeTool('read')
    v2.description = 'updated'
    registerTool(reg, v2)
    expect(getTool(reg, 'read')?.description).toBe('updated')
    expect(listTools(reg).length).toBe(1)
  })

  it('registers a lazy factory', () => {
    const reg = createToolRegistry()
    let factoryCalled = false
    registerToolFactory(reg, 'lazy', (ctx) => {
      factoryCalled = true
      return makeTool('lazy')
    })
    // Factory not called until getTool
    expect(factoryCalled).toBe(false)
    const tool = getTool(reg, 'lazy', { config: {}, cwd: '/tmp' })
    expect(factoryCalled).toBe(true)
    expect(tool?.name).toBe('lazy')
  })

  it('factory returning null registers nothing', () => {
    const reg = createToolRegistry()
    registerToolFactory(reg, 'noop', () => null)
    expect(getTool(reg, 'noop', { config: {}, cwd: '/tmp' })).toBeUndefined()
  })

  it('caches factory result after first getTool call', () => {
    const reg = createToolRegistry()
    let callCount = 0
    registerToolFactory(reg, 'cached', () => {
      callCount++
      return makeTool('cached')
    })
    getTool(reg, 'cached', { config: {}, cwd: '/tmp' })
    getTool(reg, 'cached', { config: {}, cwd: '/tmp' })
    expect(callCount).toBe(1)
  })

  it('listTools triggers all factories', () => {
    const reg = createToolRegistry()
    registerTool(reg, makeTool('eager1'))
    registerToolFactory(reg, 'lazy1', () => makeTool('lazy1'))
    registerToolFactory(reg, 'lazy2', () => null) // unavailable

    const tools = listTools(reg, { config: {}, cwd: '/tmp' })
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['eager1', 'lazy1'])
  })

  it('getToolSchemas returns ChatTool array', () => {
    const reg = createToolRegistry()
    registerTool(reg, makeTool('read'))
    registerTool(reg, makeTool('write'))
    const schemas = getToolSchemas(reg)
    expect(schemas.length).toBe(2)
    expect(schemas[0]).toHaveProperty('name')
    expect(schemas[0]).toHaveProperty('description')
    expect(schemas[0]).toHaveProperty('parameters')
  })
})
```

### Step 2: Run test to verify it fails

- [ ] Run: `pnpm test src/tools/registry.test.ts`
- Expected: FAIL — `Cannot find module './registry.js'`

### Step 3: Write minimal implementation

- [ ] **Create `src/tools/registry.ts`:**

```typescript
import type { ChatTool } from '../shared/types/llm.js'
import type { ToolDef } from '../shared/types/tool.js'
import type { ToolFactory, ToolFactoryContext, ToolRegistry } from './types.js'

/** Create an empty tool registry. */
export function createToolRegistry(): ToolRegistry {
  return { tools: new Map(), factories: new Map() }
}

/** Register a fully-constructed tool definition (eager). */
export function registerTool(registry: ToolRegistry, tool: ToolDef): void {
  registry.tools.set(tool.name, tool)
}

/** Register a lazy factory that constructs the tool on first access. */
export function registerToolFactory(
  registry: ToolRegistry,
  name: string,
  factory: ToolFactory,
): void {
  registry.factories.set(name, factory)
}

/** Get a tool by name. Triggers and caches lazy factories. Returns undefined if not found. */
export function getTool(
  registry: ToolRegistry,
  name: string,
  ctx?: ToolFactoryContext,
): ToolDef | undefined {
  // Check eager tools first
  const eager = registry.tools.get(name)
  if (eager) return eager

  // Check lazy factories
  const factory = registry.factories.get(name)
  if (factory && ctx) {
    const tool = factory(ctx)
    if (tool) {
      registry.tools.set(name, tool) // cache
      registry.factories.delete(name)
      return tool
    }
    // Factory returned null → remove
    registry.factories.delete(name)
  }

  return undefined
}

/** List all tools. Triggers and caches all lazy factories. */
export function listTools(registry: ToolRegistry, ctx?: ToolFactoryContext): ToolDef[] {
  // Materialize factories if context is provided
  if (ctx) {
    for (const [name, factory] of registry.factories) {
      const tool = factory(ctx)
      if (tool) {
        registry.tools.set(name, tool)
      }
      registry.factories.delete(name)
    }
  }
  return Array.from(registry.tools.values())
}

/** Convert registered tools to ChatTool[] for sending to the LLM. */
export function getToolSchemas(registry: ToolRegistry, ctx?: ToolFactoryContext): ChatTool[] {
  return listTools(registry, ctx).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
}
```

### Step 4: Run test to verify it passes

- [ ] Run: `pnpm test src/tools/registry.test.ts`
- Expected: PASS (all 8 tests)

### Step 5: Commit

- [ ] Run: `git add src/tools/registry.ts src/tools/registry.test.ts && git commit -m "feat(tools): add tool registry with lazy factory support"`

---

## Task 5: Permission Checker

**Files:**
- Create: `src/tools/permission.ts`
- Test: `src/tools/permission.test.ts`

### Step 1: Write the failing test

- [ ] **Create `src/tools/permission.test.ts`:**

```typescript
import { describe, it, expect, vi } from 'vitest'
import type { ToolDef } from '../shared/types/tool.js'
import { createPermissionChecker, autoAllowChecker } from './permission.js'

function makeTool(permission: 'auto' | 'ask' | 'deny'): ToolDef {
  return {
    name: 'test',
    description: 'test',
    parameters: { type: 'object' },
    permission,
    execute: async () => ({ _tag: 'success', output: '' }),
  }
}

describe('autoAllowChecker', () => {
  it('allows auto tools', async () => {
    const result = await autoAllowChecker.check(makeTool('auto'), {}, {
      cwd: '/tmp',
      session: { id: 's1', cwd: '/tmp' },
      abort: new AbortController().signal,
    })
    expect(result._tag).toBe('allow')
  })

  it('asks for ask tools', async () => {
    const result = await autoAllowChecker.check(makeTool('ask'), {}, {
      cwd: '/tmp',
      session: { id: 's1', cwd: '/tmp' },
      abort: new AbortController().signal,
    })
    expect(result._tag).toBe('ask')
    if (result._tag === 'ask') {
      expect(result.reason).toBeTruthy()
      expect(result.toolCallId).toBeTruthy()
    }
  })

  it('denies deny tools', async () => {
    const result = await autoAllowChecker.check(makeTool('deny'), {}, {
      cwd: '/tmp',
      session: { id: 's1', cwd: '/tmp' },
      abort: new AbortController().signal,
    })
    expect(result._tag).toBe('deny')
  })
})

describe('createPermissionChecker', () => {
  it('uses provided config for allowed/denied tool names', async () => {
    const checker = createPermissionChecker({
      alwaysAllow: ['bash'],
      alwaysDeny: ['rm'],
    })
    const ctx = {
      cwd: '/tmp',
      session: { id: 's1', cwd: '/tmp' },
      abort: new AbortController().signal,
    }

    // bash is 'ask' but explicitly allowed
    const bashResult = await checker.check(makeTool('ask'), {}, ctx)
    expect(bashResult._tag).toBe('allow')

    // rm is 'auto' but explicitly denied
    const rmTool = makeTool('auto')
    rmTool.name = 'rm'
    const rmResult = await checker.check(rmTool, {}, ctx)
    expect(rmResult._tag).toBe('deny')
  })

  it('falls through to tool permission for unlisted tools', async () => {
    const checker = createPermissionChecker({})
    const ctx = {
      cwd: '/tmp',
      session: { id: 's1', cwd: '/tmp' },
      abort: new AbortController().signal,
    }
    const result = await checker.check(makeTool('ask'), {}, ctx)
    expect(result._tag).toBe('ask')
  })

  it('confirm is a no-op by default', () => {
    const checker = createPermissionChecker({})
    expect(() => checker.confirm('tc1', true)).not.toThrow()
  })

  it('generates unique toolCallIds', async () => {
    const ctx = {
      cwd: '/tmp',
      session: { id: 's1', cwd: '/tmp' },
      abort: new AbortController().signal,
    }
    const r1 = await autoAllowChecker.check(makeTool('ask'), {}, ctx)
    const r2 = await autoAllowChecker.check(makeTool('ask'), {}, ctx)
    if (r1._tag === 'ask' && r2._tag === 'ask') {
      expect(r1.toolCallId).not.toBe(r2.toolCallId)
    }
  })
})
```

### Step 2: Run test to verify it fails

- [ ] Run: `pnpm test src/tools/permission.test.ts`
- Expected: FAIL — `Cannot find module './permission.js'`

### Step 3: Write minimal implementation

- [ ] **Create `src/tools/permission.ts`:**

```typescript
import { randomUUID } from 'node:crypto'
import type { ToolContext, ToolDef } from '../shared/types/tool.js'
import type { PermissionChecker, PermissionResult } from './types.js'

/** Permission checker configuration. */
type PermissionConfig = {
  /** Tool names that are always allowed, regardless of their declared permission. */
  alwaysAllow?: string[]
  /** Tool names that are always denied, regardless of their declared permission. */
  alwaysDeny?: string[]
}

/** Default checker: allows auto, asks for ask, denies deny. No persistent state. */
export const autoAllowChecker: PermissionChecker = {
  check: async (_tool: ToolDef, _input: unknown, _ctx: ToolContext): Promise<PermissionResult> => {
    return checkPermission(_tool, _input)
  },
  confirm: (_toolCallId: string, _approved: boolean) => {},
}

function checkPermission(tool: ToolDef, _input: unknown): PermissionResult {
  switch (tool.permission) {
    case 'auto':
      return { _tag: 'allow' }
    case 'deny':
      return { _tag: 'deny', reason: `Tool "${tool.name}" is disabled` }
    case 'ask':
      return {
        _tag: 'ask',
        reason: `Tool "${tool.name}" requires confirmation`,
        toolCallId: randomUUID(),
      }
  }
}

/** Create a permission checker with configurable allow/deny lists. */
export function createPermissionChecker(config: PermissionConfig): PermissionChecker {
  const allowSet = new Set(config.alwaysAllow ?? [])
  const denySet = new Set(config.alwaysDeny ?? [])

  return {
    check: async (tool: ToolDef, _input: unknown, _ctx: ToolContext): Promise<PermissionResult> => {
      if (denySet.has(tool.name)) {
        return { _tag: 'deny', reason: `Tool "${tool.name}" is disabled by configuration` }
      }
      if (allowSet.has(tool.name)) {
        return { _tag: 'allow' }
      }
      return checkPermission(tool, _input)
    },
    confirm: (_toolCallId: string, _approved: boolean) => {},
  }
}
```

### Step 4: Run test to verify it passes

- [ ] Run: `pnpm test src/tools/permission.test.ts`
- Expected: PASS (all 7 tests)

### Step 5: Commit

- [ ] Run: `git add src/tools/permission.ts src/tools/permission.test.ts && git commit -m "feat(tools): add permission checker"`

---

## Task 6: Tool Executor

**Files:**
- Create: `src/tools/executor.ts`
- Test: `src/tools/executor.test.ts`

### Step 1: Write the failing test

- [ ] **Create `src/tools/executor.test.ts`:**

```typescript
import { describe, it, expect } from 'vitest'
import type { ToolContext, ToolDef, ToolResult } from '../shared/types/tool.js'
import {
  createToolRegistry,
  registerTool,
} from './registry.js'
import { autoAllowChecker, createPermissionChecker } from './permission.js'
import { executeTool } from './executor.js'

const ctx: ToolContext = {
  cwd: '/tmp',
  session: { id: 's1', cwd: '/tmp' },
  abort: new AbortController().signal,
}

function makeTool(
  name: string,
  execute: (input: unknown) => Promise<ToolResult>,
  permission: 'auto' | 'ask' | 'deny' = 'auto',
): ToolDef {
  return {
    name,
    description: name,
    parameters: {
      type: 'object',
      properties: { msg: { type: 'string' } },
      required: ['msg'],
    },
    permission,
    execute: async (input) => execute(input),
  }
}

describe('executeTool', () => {
  it('executes a valid auto tool', async () => {
    const reg = createToolRegistry()
    registerTool(reg, makeTool('echo', async (input) => ({
      _tag: 'success',
      output: `echo: ${(input as { msg: string }).msg}`,
    })))
    const result = await executeTool(reg, 'echo', { msg: 'hello' }, ctx, autoAllowChecker)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toBe('echo: hello')
    }
  })

  it('returns error for unknown tool', async () => {
    const reg = createToolRegistry()
    const result = await executeTool(reg, 'nonexistent', {}, ctx, autoAllowChecker)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('nonexistent')
    }
  })

  it('returns error for invalid input', async () => {
    const reg = createToolRegistry()
    registerTool(reg, makeTool('echo', async () => ({ _tag: 'success', output: '' })))
    const result = await executeTool(reg, 'echo', {}, ctx, autoAllowChecker) // missing required 'msg'
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('msg')
    }
  })

  it('returns permission_required for ask tools', async () => {
    const reg = createToolRegistry()
    registerTool(reg, makeTool('write', async () => ({ _tag: 'success', output: '' }), 'ask'))
    const result = await executeTool(reg, 'write', { msg: 'x' }, ctx, autoAllowChecker)
    expect(result._tag).toBe('permission_required')
  })

  it('returns error for denied tools', async () => {
    const reg = createToolRegistry()
    registerTool(reg, makeTool('rm', async () => ({ _tag: 'success', output: '' }), 'deny'))
    const result = await executeTool(reg, 'rm', { msg: 'x' }, ctx, autoAllowChecker)
    expect(result._tag).toBe('error')
  })

  it('catches tool execution errors', async () => {
    const reg = createToolRegistry()
    registerTool(
      reg,
      makeTool('boom', async () => {
        throw new Error('kaboom')
      }),
    )
    const result = await executeTool(reg, 'boom', { msg: 'x' }, ctx, autoAllowChecker)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('kaboom')
    }
  })

  it('truncates large output', async () => {
    const reg = createToolRegistry()
    const longOutput = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
    registerTool(reg, makeTool('big', async () => ({
      _tag: 'success',
      output: longOutput,
    })))
    const result = await executeTool(reg, 'big', { msg: 'x' }, ctx, autoAllowChecker)
    expect(result._tag).toBe('truncated')
    if (result._tag === 'truncated') {
      expect(result.truncated).toBe(true)
      expect(result.totalLines).toBe(5000)
    }
  })

  it('uses custom permission checker', async () => {
    const reg = createToolRegistry()
    registerTool(reg, makeTool('bash', async () => ({ _tag: 'success', output: '' }), 'ask'))
    // bash is always allowed
    const checker = createPermissionChecker({ alwaysAllow: ['bash'] })
    const result = await executeTool(reg, 'bash', { msg: 'ls' }, ctx, checker)
    expect(result._tag).toBe('success')
  })

  it('honors abort signal', async () => {
    const reg = createToolRegistry()
    const ac = new AbortController()
    ac.abort()
    const abortedCtx: ToolContext = {
      cwd: '/tmp',
      session: { id: 's1', cwd: '/tmp' },
      abort: ac.signal,
    }
    registerTool(reg, makeTool('echo', async () => ({ _tag: 'success', output: 'ok' })))
    const result = await executeTool(reg, 'echo', { msg: 'x' }, abortedCtx, autoAllowChecker)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('abort')
    }
  })
})
```

### Step 2: Run test to verify it fails

- [ ] Run: `pnpm test src/tools/executor.test.ts`
- Expected: FAIL — `Cannot find module './executor.js'`

### Step 3: Write minimal implementation

- [ ] **Create `src/tools/executor.ts`:**

```typescript
import type { ToolContext, ToolResult } from '../shared/types/tool.js'
import type { PermissionChecker, ToolRegistry } from './types.js'
import { getTool } from './registry.js'
import { validateInput } from './validate.js'
import { truncateOutput } from './truncate.js'

/**
 * Execute a tool by name with full pipeline:
 * find tool → validate input → check permission → execute → truncate output.
 *
 * Returns the ToolResult. Never throws — all errors become { _tag: 'error' }.
 */
export async function executeTool(
  registry: ToolRegistry,
  name: string,
  input: unknown,
  ctx: ToolContext,
  permissionChecker: PermissionChecker,
): Promise<ToolResult> {
  // 0. Check abort signal
  if (ctx.abort.aborted) {
    return { _tag: 'error', error: 'Operation aborted before execution' }
  }

  // 1. Find tool
  const tool = getTool(registry, name, { config: {}, cwd: ctx.cwd })
  if (!tool) {
    return { _tag: 'error', error: `Tool not found: ${name}` }
  }

  // 2. Validate input against JSON Schema
  const validation = validateInput(tool.parameters, input)
  if (!validation.valid) {
    return { _tag: 'error', error: `Invalid input for "${name}": ${validation.error}` }
  }

  // 3. Check permission
  const permission = await permissionChecker.check(tool, input, ctx)
  if (permission._tag === 'deny') {
    return { _tag: 'error', error: `Permission denied: ${permission.reason}` }
  }
  if (permission._tag === 'ask') {
    return { _tag: 'permission_required', reason: permission.reason }
  }

  // 4. Execute
  try {
    const result = await tool.execute(input, ctx)

    // 5. Truncate large output
    if (result._tag === 'success') {
      const truncated = truncateOutput(result.output)
      if (truncated.truncated) {
        return {
          _tag: 'truncated',
          output: truncated.output,
          truncated: true,
          totalLines: truncated.totalLines,
        }
      }
    }

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { _tag: 'error', error: `Tool "${name}" failed: ${message}` }
  }
}
```

### Step 4: Run test to verify it passes

- [ ] Run: `pnpm test src/tools/executor.test.ts`
- Expected: PASS (all 9 tests)

### Step 5: Commit

- [ ] Run: `git add src/tools/executor.ts src/tools/executor.test.ts && git commit -m "feat(tools): add tool executor pipeline"`

---

## Task 7: read Tool

**Files:**
- Create: `src/tools/builtin/read.ts`
- Test: `src/tools/builtin/read.test.ts`

### Step 1: Write the failing test

- [ ] **Create `src/tools/builtin/read.test.ts`:**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '../../shared/types/tool.js'
import { readTool } from './read.js'

let workDir: string
let ctx: ToolContext

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'read-test-'))
  ctx = {
    cwd: workDir,
    session: { id: 's1', cwd: workDir },
    abort: new AbortController().signal,
  }
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

async function mkdtemp(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `read-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

describe('readTool', () => {
  it('reads a file fully', async () => {
    await writeFile(join(workDir, 'test.txt'), 'line1\nline2\nline3')
    const result = await readTool.execute({ path: 'test.txt' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('line1')
      expect(result.output).toContain('line3')
    }
  })

  it('reads with offset', async () => {
    await writeFile(join(workDir, 'test.txt'), 'line1\nline2\nline3\nline4\nline5')
    const result = await readTool.execute({ path: 'test.txt', offset: 2 }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).not.toContain('line1')
      expect(result.output).toContain('line2')
    }
  })

  it('reads with limit', async () => {
    await writeFile(join(workDir, 'test.txt'), 'line1\nline2\nline3\nline4\nline5')
    const result = await readTool.execute({ path: 'test.txt', offset: 1, limit: 2 }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('line1')
      expect(result.output).toContain('line2')
      expect(result.output).not.toContain('line3')
    }
  })

  it('returns error for non-existent file', async () => {
    const result = await readTool.execute({ path: 'nope.txt' }, ctx)
    expect(result._tag).toBe('error')
  })

  it('reads from absolute path', async () => {
    const abs = join(workDir, 'abs.txt')
    await writeFile(abs, 'absolute')
    const result = await readTool.execute({ path: abs }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toBe('absolute')
    }
  })

  it('has correct tool definition', () => {
    expect(readTool.name).toBe('read')
    expect(readTool.permission).toBe('auto')
    expect(readTool.parameters.type).toBe('object')
    expect(readTool.parameters.required).toContain('path')
  })
})
```

### Step 2: Run test to verify it fails

- [ ] Run: `pnpm test src/tools/builtin/read.test.ts`
- Expected: FAIL — `Cannot find module './read.js'`

### Step 3: Write minimal implementation

- [ ] **Create `src/tools/builtin/read.ts`:**

```typescript
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import type { ReadInput } from '../types.js'

/**
 * read tool: read file content with optional line range.
 * Permission: auto (read-only).
 */
export const readTool: ToolDef = {
  name: 'read',
  description:
    'Read file content. Supports optional offset (1-indexed line number) and limit (number of lines).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to cwd or absolute).' },
      offset: { type: 'number', description: 'Starting line number (1-indexed). Default: 1.' },
      limit: { type: 'number', description: 'Maximum number of lines to read.' },
    },
    required: ['path'],
  },
  permission: 'auto',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { path, offset, limit } = input as ReadInput
    const fullPath = resolve(ctx.cwd, path)

    try {
      const content = await readFile(fullPath, 'utf-8')

      if (offset === undefined && limit === undefined) {
        return { _tag: 'success', output: content }
      }

      const lines = content.split('\n')
      const start = (offset ?? 1) - 1 // convert to 0-indexed
      const end = limit !== undefined ? start + limit : lines.length
      const sliced = lines.slice(start, end)
      return { _tag: 'success', output: sliced.join('\n') }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { _tag: 'error', error: `Failed to read "${path}": ${message}` }
    }
  },
}
```

### Step 4: Run test to verify it passes

- [ ] Run: `pnpm test src/tools/builtin/read.test.ts`
- Expected: PASS (all 6 tests)

### Step 5: Commit

- [ ] Run: `git add src/tools/builtin/read.ts src/tools/builtin/read.test.ts && git commit -m "feat(tools): add read tool"`

---

## Task 8: write Tool

**Files:**
- Create: `src/tools/builtin/write.ts`
- Test: `src/tools/builtin/write.test.ts`

### Step 1: Write the failing test

- [ ] **Create `src/tools/builtin/write.test.ts`:**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '../../shared/types/tool.js'
import { writeTool } from './write.js'

let workDir: string
let ctx: ToolContext

beforeEach(async () => {
  workDir = join(tmpdir(), `write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(workDir, { recursive: true })
  ctx = {
    cwd: workDir,
    session: { id: 's1', cwd: workDir },
    abort: new AbortController().signal,
  }
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe('writeTool', () => {
  it('creates a new file', async () => {
    const result = await writeTool.execute({ path: 'new.txt', content: 'hello world' }, ctx)
    expect(result._tag).toBe('success')
    const written = await readFile(join(workDir, 'new.txt'), 'utf-8')
    expect(written).toBe('hello world')
  })

  it('overwrites an existing file', async () => {
    await writeTool.execute({ path: 'file.txt', content: 'old' }, ctx)
    await writeTool.execute({ path: 'file.txt', content: 'new' }, ctx)
    const written = await readFile(join(workDir, 'file.txt'), 'utf-8')
    expect(written).toBe('new')
  })

  it('creates parent directories', async () => {
    const result = await writeTool.execute(
      { path: 'sub/dir/file.txt', content: 'nested' },
      ctx,
    )
    expect(result._tag).toBe('success')
    const written = await readFile(join(workDir, 'sub/dir/file.txt'), 'utf-8')
    expect(written).toBe('nested')
  })

  it('writes to absolute path', async () => {
    const abs = join(workDir, 'abs.txt')
    await writeTool.execute({ path: abs, content: 'abs' }, ctx)
    const written = await readFile(abs, 'utf-8')
    expect(written).toBe('abs')
  })

  it('returns error on permission denied', async () => {
    const result = await writeTool.execute(
      { path: '/proc/cannot-write-here', content: 'x' },
      ctx,
    )
    expect(result._tag).toBe('error')
  })

  it('has correct tool definition', () => {
    expect(writeTool.name).toBe('write')
    expect(writeTool.permission).toBe('ask')
    expect(writeTool.parameters.required).toEqual(['path', 'content'])
  })
})
```

### Step 2: Run test to verify it fails

- [ ] Run: `pnpm test src/tools/builtin/write.test.ts`
- Expected: FAIL — `Cannot find module './write.js'`

### Step 3: Write minimal implementation

- [ ] **Create `src/tools/builtin/write.ts`:**

```typescript
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import type { WriteInput } from '../types.js'

/**
 * write tool: create or overwrite a file.
 * Permission: ask (modifies filesystem).
 */
export const writeTool: ToolDef = {
  name: 'write',
  description: 'Create or overwrite a file with the given content. Creates parent directories.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to cwd or absolute).' },
      content: { type: 'string', description: 'Content to write.' },
    },
    required: ['path', 'content'],
  },
  permission: 'ask',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { path, content } = input as WriteInput
    const fullPath = resolve(ctx.cwd, path)

    try {
      await mkdir(dirname(fullPath), { recursive: true })
      await writeFile(fullPath, content, 'utf-8')
      return { _tag: 'success', output: `Wrote ${content.length} bytes to ${path}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { _tag: 'error', error: `Failed to write "${path}": ${message}` }
    }
  },
}
```

### Step 4: Run test to verify it passes

- [ ] Run: `pnpm test src/tools/builtin/write.test.ts`
- Expected: PASS (all 6 tests)

### Step 5: Commit

- [ ] Run: `git add src/tools/builtin/write.ts src/tools/builtin/write.test.ts && git commit -m "feat(tools): add write tool"`

---

## Task 9: edit Tool

**Files:**
- Create: `src/tools/builtin/edit.ts`
- Test: `src/tools/builtin/edit.test.ts`

### Step 1: Write the failing test

- [ ] **Create `src/tools/builtin/edit.test.ts`:**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '../../shared/types/tool.js'
import { editTool } from './edit.js'

let workDir: string
let ctx: ToolContext

beforeEach(async () => {
  workDir = join(tmpdir(), `edit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(workDir, { recursive: true })
  ctx = {
    cwd: workDir,
    session: { id: 's1', cwd: workDir },
    abort: new AbortController().signal,
  }
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe('editTool', () => {
  it('replaces exact text', async () => {
    await writeFile(join(workDir, 'f.ts'), 'const x = 1\nconst y = 2\n')
    const result = await editTool.execute(
      { path: 'f.ts', oldText: 'const x = 1', newText: 'const x = 42' },
      ctx,
    )
    expect(result._tag).toBe('success')
    const content = await readFile(join(workDir, 'f.ts'), 'utf-8')
    expect(content).toBe('const x = 42\nconst y = 2\n')
  })

  it('replaces multiline text', async () => {
    await writeFile(join(workDir, 'f.ts'), 'function foo() {\n  return 1\n}\n')
    const result = await editTool.execute(
      {
        path: 'f.ts',
        oldText: 'function foo() {\n  return 1\n}',
        newText: 'function foo() {\n  return 42\n}',
      },
      ctx,
    )
    expect(result._tag).toBe('success')
    const content = await readFile(join(workDir, 'f.ts'), 'utf-8')
    expect(content).toContain('return 42')
  })

  it('returns error when oldText not found', async () => {
    await writeFile(join(workDir, 'f.ts'), 'hello world\n')
    const result = await editTool.execute(
      { path: 'f.ts', oldText: 'nonexistent', newText: 'x' },
      ctx,
    )
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('not found')
    }
  })

  it('returns error when oldText matches multiple times', async () => {
    await writeFile(join(workDir, 'f.ts'), 'dup\ndup\n')
    const result = await editTool.execute(
      { path: 'f.ts', oldText: 'dup', newText: 'unique' },
      ctx,
    )
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('multiple')
    }
  })

  it('fuzzy matches with different whitespace', async () => {
    await writeFile(join(workDir, 'f.ts'), 'const x = 1\nconst y = 2\n')
    // oldText has extra spaces — should still match via fuzzy whitespace
    const result = await editTool.execute(
      { path: 'f.ts', oldText: 'const  x  =  1', newText: 'const x = 42' },
      ctx,
    )
    expect(result._tag).toBe('success')
  })

  it('returns error for non-existent file', async () => {
    const result = await editTool.execute(
      { path: 'nope.ts', oldText: 'a', newText: 'b' },
      ctx,
    )
    expect(result._tag).toBe('error')
  })

  it('has correct tool definition', () => {
    expect(editTool.name).toBe('edit')
    expect(editTool.permission).toBe('ask')
    expect(editTool.parameters.required).toEqual(['path', 'oldText', 'newText'])
  })
})
```

### Step 2: Run test to verify it fails

- [ ] Run: `pnpm test src/tools/builtin/edit.test.ts`
- Expected: FAIL — `Cannot find module './edit.js'`

### Step 3: Write minimal implementation

- [ ] **Create `src/tools/builtin/edit.ts`:**

```typescript
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import type { EditInput } from '../types.js'

/**
 * edit tool: search-and-replace editing with fuzzy whitespace matching.
 * Permission: ask (modifies filesystem).
 *
 * Matching: collapses consecutive whitespace in both oldText and file content
 * to support minor formatting differences. Returns error if oldText is not
 * found or matches multiple times (ambiguous).
 */
export const editTool: ToolDef = {
  name: 'edit',
  description:
    'Edit a file by replacing oldText with newText. Uses fuzzy whitespace matching. Returns error if oldText is not found or matches multiple times.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to cwd or absolute).' },
      oldText: { type: 'string', description: 'Text to find in the file.' },
      newText: { type: 'string', description: 'Replacement text.' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  permission: 'ask',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { path, oldText, newText } = input as EditInput
    const fullPath = resolve(ctx.cwd, path)

    try {
      const content = await readFile(fullPath, 'utf-8')

      // Fuzzy whitespace matching: normalize whitespace runs
      const normalize = (s: string): string => s.replace(/[ \t]+/g, ' ')

      const normalizedContent = normalize(content)
      const normalizedOld = normalize(oldText)

      // Find all match positions
      const matches: number[] = []
      let searchFrom = 0
      while (true) {
        const idx = normalizedContent.indexOf(normalizedOld, searchFrom)
        if (idx === -1) break
        matches.push(idx)
        searchFrom = idx + normalizedOld.length
      }

      if (matches.length === 0) {
        return { _tag: 'error', error: `oldText not found in "${path}"` }
      }
      if (matches.length > 1) {
        return {
          _tag: 'error',
          error: `oldText matches ${matches.length} times in "${path}" — provide more context to disambiguate`,
        }
      }

      // Map normalized match back to original content
      // Strategy: find the first occurrence in original content that normalizes to a match at the right position
      // Simpler approach: use the normalized match position to approximate, then search in original
      const matchIdx = matches[0]!
      const prefix = normalizedContent.slice(0, matchIdx)
      const charCount = prefix.length

      // Reconstruct: original prefix (up to char count) + newText + original suffix
      // But we need to map the normalized positions back to original positions.
      // Build a position mapping from normalized → original.
      const mapping = buildPositionMapping(content, normalizedContent)

      const origStart = mapping.get(charCount) ?? charCount
      const origEnd = mapping.get(charCount + normalizedOld.length) ?? charCount + normalizedOld.length

      const newContent = content.slice(0, origStart) + newText + content.slice(origEnd)
      await writeFile(fullPath, newContent, 'utf-8')
      return {
        _tag: 'success',
        output: `Edited "${path}": replaced ${origEnd - origStart} chars with ${newText.length} chars`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { _tag: 'error', error: `Failed to edit "${path}": ${message}` }
    }
  },
}

/**
 * Build a mapping from normalized string positions to original string positions.
 * Used to map fuzzy match results back to the original content.
 */
function buildPositionMapping(original: string, normalized: string): Map<number, number> {
  const map = new Map<number, number>()
  let origIdx = 0
  let normIdx = 0

  while (origIdx < original.length && normIdx < normalized.length) {
    map.set(normIdx, origIdx)

    if (original[origIdx] === normalized[normIdx]) {
      origIdx++
      normIdx++
    } else if (original[origIdx] === ' ' || original[origIdx] === '\t') {
      // Original has whitespace that was collapsed
      origIdx++
    } else {
      // Shouldn't happen with proper normalization
      origIdx++
      normIdx++
    }
  }
  // Map the end position
  map.set(normIdx, origIdx)
  return map
}
```

### Step 4: Run test to verify it passes

- [ ] Run: `pnpm test src/tools/builtin/edit.test.ts`
- Expected: PASS (all 7 tests)

### Step 5: Commit

- [ ] Run: `git add src/tools/builtin/edit.ts src/tools/builtin/edit.test.ts && git commit -m "feat(tools): add edit tool with fuzzy whitespace matching"`

---

## Task 10: glob Tool

**Files:**
- Create: `src/tools/builtin/glob.ts`
- Test: `src/tools/builtin/glob.test.ts`

### Step 1: Write the failing test

- [ ] **Create `src/tools/builtin/glob.test.ts`:**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '../../shared/types/tool.js'
import { globTool, globToRegex } from './glob.js'

let workDir: string
let ctx: ToolContext

beforeEach(async () => {
  workDir = join(tmpdir(), `glob-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(workDir, { recursive: true })
  ctx = {
    cwd: workDir,
    session: { id: 's1', cwd: workDir },
    abort: new AbortController().signal,
  }
})

afterEach(async () => {
  await rm(workDir, recursive: true, force: true })
})

async function setupFiles() {
  await mkdir(join(workDir, 'src'), { recursive: true })
  await mkdir(join(workDir, 'src', 'utils'), { recursive: true })
  await mkdir(join(workDir, 'node_modules'), { recursive: true })
  await mkdir(join(workDir, '.git'), { recursive: true })
  await writeFile(join(workDir, 'src', 'a.ts'), 'x')
  await writeFile(join(workDir, 'src', 'b.ts'), 'x')
  await writeFile(join(workDir, 'src', 'c.js'), 'x')
  await writeFile(join(workDir, 'src', 'utils', 'd.ts'), 'x')
  await writeFile(join(workDir, 'readme.md'), 'x')
  await writeFile(join(workDir, 'node_modules', 'dep.js'), 'x')
  await writeFile(join(workDir, '.git', 'config'), 'x')
}

describe('globToRegex', () => {
  it('matches simple wildcard', () => {
    const re = globToRegex('*.ts')
    expect(re.test('foo.ts')).toBe(true)
    expect(re.test('foo.js')).toBe(false)
  })

  it('matches double-star across directories', () => {
    const re = globToRegex('src/**/*.ts')
    expect(re.test('src/a.ts')).toBe(true)
    expect(re.test('src/utils/d.ts')).toBe(true)
    expect(re.test('src/utils/sub/e.ts')).toBe(true)
    expect(re.test('src/a.js')).toBe(false)
  })

  it('matches brace expansion', () => {
    const re = globToRegex('*.{ts,js}')
    expect(re.test('a.ts')).toBe(true)
    expect(re.test('a.js')).toBe(true)
    expect(re.test('a.md')).toBe(false)
  })

  it('matches question mark', () => {
    const re = globToRegex('?.ts')
    expect(re.test('a.ts')).toBe(true)
    expect(re.test('ab.ts')).toBe(false)
  })
})

describe('globTool', () => {
  it('finds files matching pattern', async () => {
    await setupFiles()
    const result = await globTool.execute({ pattern: 'src/**/*.ts' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('a.ts')
      expect(result.output).toContain('b.ts')
      expect(result.output).toContain('utils/d.ts')
      expect(result.output).not.toContain('c.js')
    }
  })

  it('finds files in root', async () => {
    await setupFiles()
    const result = await globTool.execute({ pattern: '*.md' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('readme.md')
    }
  })

  it('finds multiple extensions', async () => {
    await setupFiles()
    const result = await globTool.execute({ pattern: 'src/*.{ts,js}' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('a.ts')
      expect(result.output).toContain('c.js')
    }
  })

  it('ignores node_modules and .git', async () => {
    await setupFiles()
    const result = await globTool.execute({ pattern: '**/*' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).not.toContain('node_modules')
      expect(result.output).not.toContain('.git')
    }
  })

  it('returns empty result for no matches', async () => {
    await setupFiles()
    const result = await globTool.execute({ pattern: '**/*.xyz' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output.trim()).toBe('')
    }
  })

  it('has correct tool definition', () => {
    expect(globTool.name).toBe('glob')
    expect(globTool.permission).toBe('auto')
  })
})
```

### Step 2: Run test to verify it fails

- [ ] Run: `pnpm test src/tools/builtin/glob.test.ts`
- Expected: FAIL — `Cannot find module './glob.js'`

### Step 3: Write minimal implementation

- [ ] **Create `src/tools/builtin/glob.ts`:**

```typescript
import { readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import type { GlobInput } from '../types.js'

/** Directories always skipped during glob traversal. */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.turbo'])

/**
 * Convert a glob pattern to a RegExp.
 * Supports: * (single segment), ** (across segments), ? (single char), {a,b} (alternation), [abc] (char class).
 */
export function globToRegex(pattern: string): RegExp {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i += 2
        if (pattern[i] === '/') i++ // skip separator after **
      } else {
        re += '[^/]*'
        i++
      }
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else if (c === '{') {
      const end = pattern.indexOf('}', i)
      if (end === -1) {
        re += '\\{'
        i++
      } else {
        const inner = pattern.slice(i + 1, end)
        re += `(?:${inner.split(',').map(escapeRegex).join('|')})`
        i = end + 1
      }
    } else if (c === '[') {
      const end = pattern.indexOf(']', i)
      if (end === -1) {
        re += '\\['
        i++
      } else {
        re += pattern.slice(i, end + 1)
        i = end + 1
      }
    } else if ('.+^$()|\\'.includes(c)) {
      re += `\\${c}`
      i++
    } else {
      re += c
      i++
    }
  }
  return new RegExp(`^${re}$`)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Recursively walk a directory, skipping IGNORE_DIRS. Returns relative file paths. */
async function walkDir(dir: string, base: string): Promise<string[]> {
  const results: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue
      const sub = await walkDir(join(dir, entry.name), base)
      results.push(...sub)
    } else {
      results.push(relative(base, join(dir, entry.name)))
    }
  }
  return results
}

/**
 * glob tool: find files matching a glob pattern.
 * Permission: auto (read-only).
 */
export const globTool: ToolDef = {
  name: 'glob',
  description:
    'Find files matching a glob pattern. Supports *, **, ?, {a,b}. Searches recursively, skipping node_modules/.git/dist.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "src/**/*.ts").' },
      path: { type: 'string', description: 'Base directory to search (default: cwd).' },
    },
    required: ['pattern'],
  },
  permission: 'auto',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { pattern, path } = input as GlobInput
    const basePath = path ? resolve(ctx.cwd, path) : ctx.cwd

    try {
      const regex = globToRegex(pattern)
      const files = await walkDir(basePath, basePath)
      const matched = files.filter((f) => regex.test(f)).sort()
      return {
        _tag: 'success',
        output: matched.join('\n'),
        metadata: { count: matched.length },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { _tag: 'error', error: `Glob failed: ${message}` }
    }
  },
}
```

### Step 4: Run test to verify it passes

- [ ] Run: `pnpm test src/tools/builtin/glob.test.ts`
- Expected: PASS (all 8 tests)

### Step 5: Commit

- [ ] Run: `git add src/tools/builtin/glob.ts src/tools/builtin/glob.test.ts && git commit -m "feat(tools): add glob tool with glob-to-regex pattern matching"`

---

## Task 11: grep Tool

**Files:**
- Create: `src/tools/builtin/grep.ts`
- Test: `src/tools/builtin/grep.test.ts`

### Step 1: Write the failing test

- [ ] **Create `src/tools/builtin/grep.test.ts`:**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '../../shared/types/tool.js'
import { grepTool } from './grep.js'

let workDir: string
let ctx: ToolContext

beforeEach(async () => {
  workDir = join(tmpdir(), `grep-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(workDir, { recursive: true })
  ctx = {
    cwd: workDir,
    session: { id: 's1', cwd: workDir },
    abort: new AbortController().signal,
  }
})

afterEach(async () => {
  await rm(workDir, recursive: true, force: true })
})

describe('grepTool', () => {
  it('finds matching lines', async () => {
    await writeFile(join(workDir, 'a.ts'), 'const foo = 1\nconst bar = 2\nfoo()\n')
    const result = await grepTool.execute({ pattern: 'foo' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('a.ts')
      expect(result.output).toContain('const foo = 1')
      expect(result.output).toContain('foo()')
    }
  })

  it('supports regex patterns', async () => {
    await writeFile(join(workDir, 'a.ts'), 'const x123 = 1\nconst abc = 2\n')
    const result = await grepTool.execute({ pattern: 'x\\d+' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('x123')
      expect(result.output).not.toContain('abc')
    }
  })

  it('case insensitive search', async () => {
    await writeFile(join(workDir, 'a.ts'), 'const Hello = 1\nconst world = 2\n')
    const result = await grepTool.execute({ pattern: 'hello', caseSensitive: false }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('Hello')
    }
  })

  it('searches across multiple files', async () => {
    await mkdir(join(workDir, 'src'), { recursive: true })
    await writeFile(join(workDir, 'a.ts'), 'target line\n')
    await writeFile(join(workDir, 'src', 'b.ts'), 'another target\n')
    await writeFile(join(workDir, 'c.md'), 'nothing here\n')
    const result = await grepTool.execute({ pattern: 'target' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('a.ts')
      expect(result.output).toContain('src/b.ts')
      expect(result.output).not.toContain('c.md')
    }
  })

  it('respects maxResults', async () => {
    await writeFile(join(workDir, 'a.ts'), 'match\nmatch\nmatch\nmatch\nmatch\n')
    const result = await grepTool.execute({ pattern: 'match', maxResults: 2 }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      const lines = result.output.split('\n').filter((l) => l.includes('match'))
      expect(lines.length).toBe(2)
    }
  })

  it('returns empty for no matches', async () => {
    await writeFile(join(workDir, 'a.ts'), 'nothing\n')
    const result = await grepTool.execute({ pattern: 'xyz123' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output.trim()).toBe('')
    }
  })

  it('returns error for invalid regex', async () => {
    const result = await grepTool.execute({ pattern: '[' }, ctx)
    expect(result._tag).toBe('error')
  })

  it('has correct tool definition', () => {
    expect(grepTool.name).toBe('grep')
    expect(grepTool.permission).toBe('auto')
  })
})
```

### Step 2: Run test to verify it fails

- [ ] Run: `pnpm test src/tools/builtin/grep.test.ts`
- Expected: FAIL — `Cannot find module './grep.js'`

### Step 3: Write minimal implementation

- [ ] **Create `src/tools/builtin/grep.ts`:**

```typescript
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import type { GrepInput, GrepMatch } from '../types.js'

/** Directories always skipped during search. */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.turbo'])

/** File extensions treated as text (skip binary files). */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx',
  '.txt', '.css', '.scss', '.html', '.htm', '.xml', '.yaml', '.yml',
  '.toml', '.ini', '.env', '.sh', '.bash', '.zsh', '.py', '.rb', '.go',
  '.rs', '.java', '.kt', '.c', '.cpp', '.h', '.hpp', '.cs', '.php',
  '.swift', '.sql', '.graphql', '.gql', '.vue', '.svelte', '.astro',
])

/** Maximum file size to search (skip files > 1MB). */
const MAX_FILE_SIZE = 1024 * 1024

/** Recursively walk a directory for text files. */
async function walkForFiles(dir: string, base: string): Promise<string[]> {
  const results: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue
      const sub = await walkForFiles(join(dir, entry.name), base)
      results.push(...sub)
    } else {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'))
      if (TEXT_EXTENSIONS.has(ext) || ext === '') {
        results.push(join(dir, entry.name))
      }
    }
  }
  return results
}

/**
 * grep tool: search file contents with regex.
 * Permission: auto (read-only).
 */
export const grepTool: ToolDef = {
  name: 'grep',
  description:
    'Search file contents using regex. Searches recursively across text files, skipping node_modules/.git. Returns matching lines with file and line number.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression pattern.' },
      path: { type: 'string', description: 'Base directory to search (default: cwd).' },
      caseSensitive: { type: 'boolean', description: 'Case-sensitive search (default: true).' },
      maxResults: { type: 'number', description: 'Maximum number of matches to return.' },
    },
    required: ['pattern'],
  },
  permission: 'auto',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { pattern, path, caseSensitive = true, maxResults = 200 } = input as GrepInput
    const basePath = path ? resolve(ctx.cwd, path) : ctx.cwd

    let regex: RegExp
    try {
      regex = new RegExp(pattern, caseSensitive ? '' : 'i')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { _tag: 'error', error: `Invalid regex pattern: ${message}` }
    }

    try {
      const files = await walkForFiles(basePath, basePath)
      const matches: GrepMatch[] = []
      const max = maxResults

      outer: for (const filePath of files) {
        const stat = await readFile(filePath)
        if (stat.length > MAX_FILE_SIZE) continue

        const content = stat.toString('utf-8')
        const lines = content.split('\n')
        const relPath = relative(basePath, filePath)

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          const match = line.match(regex)
          if (match) {
            matches.push({
              file: relPath,
              line: i + 1,
              text: line.trim(),
              match: match[0] ?? '',
            })
            if (matches.length >= max) break outer
          }
        }
      }

      const output = matches
        .map((m) => `${m.file}:${m.line}: ${m.text}`)
        .join('\n')

      return {
        _tag: 'success',
        output,
        metadata: { count: matches.length, truncated: matches.length >= max },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { _tag: 'error', error: `Grep failed: ${message}` }
    }
  },
}
```

### Step 4: Run test to verify it passes

- [ ] Run: `pnpm test src/tools/builtin/grep.test.ts`
- Expected: PASS (all 8 tests)

### Step 5: Commit

- [ ] Run: `git add src/tools/builtin/grep.ts src/tools/grep.test.ts src/tools/builtin/grep.test.ts && git commit -m "feat(tools): add grep tool with regex content search"`

---

## Task 12: bash Tool

**Files:**
- Create: `src/tools/builtin/bash.ts`
- Test: `src/tools/builtin/bash.test.ts`

### Step 1: Write the failing test

- [ ] **Create `src/tools/builtin/bash.test.ts`:**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '../../shared/types/tool.js'
import { bashTool } from './bash.js'

let workDir: string
let ctx: ToolContext

beforeEach(async () => {
  workDir = join(tmpdir(), `bash-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(workDir, { recursive: true })
  ctx = {
    cwd: workDir,
    session: { id: 's1', cwd: workDir },
    abort: new AbortController().signal,
  }
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe('bashTool', () => {
  it('executes a simple command', async () => {
    const result = await bashTool.execute({ command: 'echo hello' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('hello')
    }
  })

  it('captures stdout and stderr', async () => {
    const result = await bashTool.execute({ command: 'echo out; echo err >&2' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('out')
      expect(result.output).toContain('err')
    }
  })

  it('uses custom cwd', async () => {
    await mkdir(join(workDir, 'sub'), { recursive: true })
    const result = await bashTool.execute({ command: 'pwd', cwd: join(workDir, 'sub') }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('sub')
    }
  })

  it('returns error for non-zero exit code', async () => {
    const result = await bashTool.execute({ command: 'exit 1' }, ctx)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('exit code: 1')
    }
  })

  it('respects env vars', async () => {
    const result = await bashTool.execute(
      { command: 'echo $MY_VAR', env: { MY_VAR: 'test123' } },
      ctx,
    )
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('test123')
    }
  })

  it('respects timeout', async () => {
    const result = await bashTool.execute(
      { command: 'sleep 10', timeout: 100 },
      ctx,
    )
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error.toLowerCase()).toContain('timeout')
    }
  })

  it('handles abort signal', async () => {
    const ac = new AbortController()
    const abortCtx: ToolContext = {
      cwd: workDir,
      session: { id: 's1', cwd: workDir },
      abort: ac.signal,
    }
    // Start a long-running command, abort after 50ms
    const promise = bashTool.execute({ command: 'sleep 5' }, abortCtx)
    setTimeout(() => ac.abort(), 50)
    const result = await promise
    expect(result._tag).toBe('error')
  })

  it('includes exit code in metadata', async () => {
    const result = await bashTool.execute({ command: 'true' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success' && result.metadata) {
      expect(result.metadata.exitCode).toBe(0)
    }
  })

  it('has correct tool definition', () => {
    expect(bashTool.name).toBe('bash')
    expect(bashTool.permission).toBe('ask')
  })
})
```

### Step 2: Run test to verify it fails

- [ ] Run: `pnpm test src/tools/builtin/bash.test.ts`
- Expected: FAIL — `Cannot find module './bash.js'`

### Step 3: Write minimal implementation

- [ ] **Create `src/tools/builtin/bash.ts`:**

```typescript
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import type { BashInput } from '../types.js'

/** Default timeout: 120 seconds. */
const DEFAULT_TIMEOUT = 120_000

/** Kill an entire process tree (the child and all its descendants). */
function killProcessTree(child: ChildProcess): void {
  try {
    // On Linux/macOS, negative PID kills the process group.
    // We use `detached: true` at spawn to create a new process group.
    if (child.pid) {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    // Process may have already exited — ignore
  }
}

/**
 * bash tool: execute a shell command synchronously.
 * Permission: ask (can modify filesystem, run arbitrary code).
 *
 * Features:
 * - Merges stdout + stderr
 * - Process tree kill on abort
 * - Timeout kills the process tree
 * - Returns exit code in metadata
 */
export const bashTool: ToolDef = {
  name: 'bash',
  description:
    'Execute a shell command. Merges stdout+stderr. Supports custom cwd, env, and timeout (default 120s). Returns exit code in metadata.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute.' },
      cwd: { type: 'string', description: 'Working directory (default: ctx.cwd).' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000).' },
      env: {
        type: 'object',
        description: 'Additional environment variables.',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['command'],
  },
  permission: 'ask',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { command, cwd, timeout = DEFAULT_TIMEOUT, env } = input as BashInput
    const workDir = cwd ? resolve(ctx.cwd, cwd) : ctx.cwd

    return new Promise<ToolResult>((resolvePromise) => {
      const childEnv = { ...process.env, ...env }

      const child = spawn(command, {
        cwd: workDir,
        shell: true,
        env: childEnv,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      // Timeout handler
      const timer = setTimeout(() => {
        timedOut = true
        killProcessTree(child)
      }, timeout)

      // Abort handler
      const onAbort = () => {
        clearTimeout(timer)
        killProcessTree(child)
      }
      if (ctx.abort.aborted) {
        killProcessTree(child)
        resolvePromise({ _tag: 'error', error: 'Operation aborted before execution' })
        return
      }
      ctx.abort.addEventListener('abort', onAbort, { once: true })

      child.on('close', (code: number | null) => {
        clearTimeout(timer)
        ctx.abort.removeEventListener('abort', onAbort)

        if (ctx.abort.aborted) {
          resolvePromise({ _tag: 'error', error: 'Command aborted by user' })
          return
        }

        if (timedOut) {
          resolvePromise({
            _tag: 'error',
            error: `Command timed out after ${timeout}ms\nPartial output:\n${stdout}${stderr}`,
          })
          return
        }

        const output = stdout + (stderr ? `\n${stderr}` : '')

        if (code !== null && code !== 0) {
          resolvePromise({
            _tag: 'error',
            error: `Command failed with exit code: ${code}\n${output}`,
          })
          return
        }

        resolvePromise({
          _tag: 'success',
          output: output || '(no output)',
          metadata: { exitCode: code ?? 0 },
        })
      })

      child.on('error', (err: Error) => {
        clearTimeout(timer)
        ctx.abort.removeEventListener('abort', onAbort)
        resolvePromise({
          _tag: 'error',
          error: `Failed to spawn command: ${err.message}`,
        })
      })
    })
  },
}
```

### Step 4: Run test to verify it passes

- [ ] Run: `pnpm test src/tools/builtin/bash.test.ts`
- Expected: PASS (all 9 tests)

### Step 5: Commit

- [ ] Run: `git add src/tools/builtin/bash.ts src/tools/builtin/bash.test.ts && git commit -m "feat(tools): add bash tool with process tree kill and timeout"`

---

## Task 13: Barrel Export & Default Registry

**Files:**
- Modify: `src/tools/index.ts`
- Test: `src/tools/index.test.ts`

### Step 1: Write the failing test

- [ ] **Create `src/tools/index.test.ts`:**

```typescript
import { describe, it, expect } from 'vitest'
import {
  createDefaultRegistry,
  createToolRegistry,
  registerTool,
  getTool,
  listTools,
  executeTool,
  validateInput,
  truncateOutput,
  createPermissionChecker,
  autoAllowChecker,
  globToRegex,
} from './index.js'
import type { ToolContext } from '../shared/types/tool.js'
import { readTool, writeTool, editTool, globTool, grepTool, bashTool } from './index.js'

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

  it('createDefaultRegistry registers all 6 tools', () => {
    const reg = createDefaultRegistry()
    const tools = listTools(reg)
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['bash', 'edit', 'glob', 'grep', 'read', 'write'])
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
```

### Step 2: Run test to verify it fails

- [ ] Run: `pnpm test src/tools/index.test.ts`
- Expected: FAIL — `createDefaultRegistry` not found

### Step 3: Write minimal implementation

- [ ] **Overwrite `src/tools/index.ts`:**

```typescript
// Tools package: tool registry, executor, validation, truncation, and builtin tools.

// ── Framework ───────────────────────────────────────────────
export {
  getTool,
  getToolSchemas,
  listTools,
  registerTool,
  registerToolFactory,
  createToolRegistry,
} from './registry.js'
export { autoAllowChecker, createPermissionChecker } from './permission.js'
export { executeTool } from './executor.js'
export { validateInput } from './validate.js'
export { truncateOutput, DEFAULT_TRUNCATE_OPTIONS } from './truncate.js'

// ── Builtin tools ───────────────────────────────────────────
export { readTool } from './builtin/read.js'
export { writeTool } from './builtin/write.js'
export { editTool } from './builtin/edit.js'
export { globTool, globToRegex } from './builtin/glob.js'
export { grepTool } from './builtin/grep.js'
export { bashTool } from './builtin/bash.js'

// ── Types ───────────────────────────────────────────────────
export type {
  PermissionChecker,
  PermissionResult,
  ToolFactory,
  ToolFactoryContext,
  ToolRegistry,
  ValidationResult,
  TruncateOptions,
  TruncateResult,
  BashInput,
  EditInput,
  GlobInput,
  GrepInput,
  GrepMatch,
  ReadInput,
  WriteInput,
} from './types.js'

// ── Re-exports from shared ──────────────────────────────────
export type {
  ChatTool,
  ToolContext,
  ToolDef,
  ToolExecutor,
  ToolMode,
  ToolPermission,
  ToolResult,
} from '../shared/types/tool.js'
export type { JSONSchema } from '../shared/types/base.js'

// ── Default registry ────────────────────────────────────────
import { createToolRegistry, registerTool } from './registry.js'
import { readTool } from './builtin/read.js'
import { writeTool } from './builtin/write.js'
import { editTool } from './builtin/edit.js'
import { globTool } from './builtin/glob.js'
import { grepTool } from './builtin/grep.js'
import { bashTool } from './builtin/bash.js'

/**
 * Create a registry pre-loaded with all builtin tools:
 * read, write, edit, glob, grep, bash.
 */
export function createDefaultRegistry() {
  const reg = createToolRegistry()
  registerTool(reg, readTool)
  registerTool(reg, writeTool)
  registerTool(reg, editTool)
  registerTool(reg, globTool)
  registerTool(reg, grepTool)
  registerTool(reg, bashTool)
  return reg
}
```

### Step 4: Run test to verify it passes

- [ ] Run: `pnpm test src/tools/index.test.ts`
- Expected: PASS (all 5 tests)

### Step 5: Run full tools test suite

- [ ] Run: `pnpm test src/tools/`
- Expected: All tests PASS across all files

### Step 6: Typecheck and lint

- [ ] Run: `pnpm typecheck`
- Expected: No errors

- [ ] Run: `pnpm biome check src/tools/ --write`
- Expected: Clean (or auto-fixed)

### Step 7: Commit

- [ ] Run: `git add src/tools/index.ts src/tools/index.test.ts && git commit -m "feat(tools): add barrel export and default registry"`

---

## Post-Implementation Checklist

After all 13 tasks are complete:

- [ ] Run full test suite: `pnpm test` — expect 280 (existing) + ~80 (new tools tests) = ~360 total, all passing
- [ ] Run typecheck: `pnpm typecheck` — no errors
- [ ] Run lint: `pnpm biome check src/tools/` — clean
- [ ] Verify no circular imports
- [ ] Verify tools package has no dependency on `db`, `session`, `llm`, or `core` packages (only `shared`)
