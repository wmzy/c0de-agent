# Foundation & Shared Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the c0de-agent project skeleton — package structure, TypeScript/Biome/Vitest tooling, and all shared type definitions that subsequent packages build upon.

**Architecture:** Single pnpm package with internal module directories under `src/`. Shared cross-cutting types live in `src/shared/types/`, importable by all packages. Pure TypeScript with the data+functions paradigm: `type` for data, `export function` for behavior, `_tag` discriminated unions for variants, no classes.

**Tech Stack:** TypeScript 5.7+, pnpm 10.x, Biome 2.x (format+lint), Vitest 3.x (test), Node.js 22+ (ESM).

---

## File Structure

All files created or modified in this plan:

| File | Responsibility |
|------|---------------|
| `package.json` | Project manifest, scripts, dev dependencies |
| `.gitignore` | Ignore patterns for Node/pnpm |
| `tsconfig.json` | TypeScript compiler config (strict, ESM, NodeNext) |
| `biome.json` | Biome formatter and linter config |
| `vitest.config.ts` | Vitest test runner config |
| `src/shared/utils.ts` | `generateId`, `now` utility functions |
| `src/shared/utils.test.ts` | Utility function tests |
| `src/shared/types/base.ts` | `JSONSchema`, `MessageRole`, `SessionRef` |
| `src/shared/types/base.test.ts` | Base type tests |
| `src/shared/types/tool.ts` | `ToolDef`, `ToolResult`, `ToolPermission`, `ToolContext`, `ToolExecutor`, `ToolMode` |
| `src/shared/types/tool.test.ts` | Tool type tests |
| `src/shared/types/llm.ts` | `ProviderConfig`, `ChatMessage`, `ChatTool`, `ChatRequest`, `StreamChunk`, `ModelRole`, `ModelCapabilities`, `ContentPart` |
| `src/shared/types/llm.test.ts` | LLM type tests |
| `src/shared/types/message.ts` | `Message`, `MessageContent`, `Session`, `SessionMetadata` |
| `src/shared/types/message.test.ts` | Message type tests |
| `src/shared/types/agent.ts` | `AgentState`, `AgentEvent`, `AgentStatus`, `AgentConfig`, `AgentError`, `LLMDetail`, `TokenBudget` |
| `src/shared/types/agent.test.ts` | Agent type tests |
| `src/shared/types/config.ts` | `Config`, `CompactionConfig`, `MCPServerConfig` |
| `src/shared/types/config.test.ts` | Config type tests |
| `src/shared/types/index.ts` | Re-export all shared types |
| `src/shared/index.ts` | Barrel: types + utils |
| `src/core/index.ts` | Package skeleton (empty export) |
| `src/llm/index.ts` | Package skeleton (empty export) |
| `src/tools/index.ts` | Package skeleton (empty export) |
| `src/mcp/index.ts` | Package skeleton (empty export) |
| `src/plugins/index.ts` | Package skeleton (empty export) |
| `src/session/index.ts` | Package skeleton (empty export) |
| `src/db/index.ts` | Package skeleton (empty export) |
| `src/server/index.ts` | Package skeleton (empty export) |
| `src/web/index.ts` | Package skeleton (empty export) |
| `src/cli/index.ts` | Package skeleton (empty export) |

**Type dependency chain (no cycles):**

```
base.ts        → (no imports)
tool.ts        → base.ts
llm.ts         → base.ts
message.ts     → base.ts, tool.ts
agent.ts       → base.ts, message.ts, tool.ts, llm.ts
config.ts      → llm.ts
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "c0de-agent",
  "version": "0.1.0",
  "description": "Open-source AI coding assistant with Browser-Server architecture",
  "type": "module",
  "bin": {
    "c0de": "./dist/cli/index.js"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check src/",
    "format": "biome format --write src/"
  },
  "keywords": ["ai", "coding-assistant", "llm", "agent"],
  "license": "MIT",
  "engines": {
    "node": ">=22.0.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.0.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```gitignore
node_modules/
dist/
*.tsbuildinfo
.env
.env.*
!.env.example
.DS_Store
coverage/
*.log
```

- [ ] **Step 3: Install dependencies**

Run: `pnpm install`

Expected: `Lockfile` created, `node_modules/` populated.

> **Network troubleshooting:** If `pnpm install` fails due to network issues, set proxy:
> ```bash
> export HTTP_PROXY=http://127.0.0.1:7890
> export HTTPS_PROXY=http://127.0.0.1:7890
> ```

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore pnpm-lock.yaml
git commit -m "chore: initialize project with package.json and .gitignore"
```

---

### Task 2: TypeScript + Biome Configuration

**Files:**
- Create: `tsconfig.json`
- Create: `biome.json`

- [ ] **Step 1: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "rootDir": "./src",
    "outDir": "./dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

Key choices:
- `module: "NodeNext"` + `"type": "module"` in package.json → native ESM. All relative imports require `.js` extensions.
- `verbatimModuleSyntax: true` → type-only imports must use `import type`.
- `noUncheckedIndexedAccess: true` → array/record access returns `T | undefined`, safer.
- `types: ["node"]` → Node.js globals (`AbortController`, `process`, etc.).

- [ ] **Step 2: Create `biome.json`**

```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "files": {
    "ignoreUnknown": true
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "asNeeded"
    }
  }
}
```

- [ ] **Step 3: Verify config loads**

Run: `pnpm biome check --help`

Expected: Biome help text prints without error.

Run: `pnpm tsc --version`

Expected: Version `5.x.x` prints.

- [ ] **Step 4: Commit**

```bash
git add tsconfig.json biome.json
git commit -m "chore: add TypeScript and Biome configuration"
```

---

### Task 3: Shared Utilities (TDD)

**Files:**
- Create: `src/shared/utils.ts`
- Create: `src/shared/utils.test.ts`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 2: Write the failing test**

Create `src/shared/utils.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { generateId, now } from './utils.js'

describe('generateId', () => {
  it('returns a UUID v4 string', () => {
    const id = generateId()
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('produces unique values on successive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()))
    expect(ids.size).toBe(100)
  })
})

describe('now', () => {
  it('returns a positive integer (milliseconds since epoch)', () => {
    const ts = now()
    expect(typeof ts).toBe('number')
    expect(Number.isInteger(ts)).toBe(true)
    expect(ts).toBeGreaterThan(0)
  })

  it('returns a value close to Date.now()', () => {
    const before = Date.now()
    const ts = now()
    const after = Date.now()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test src/shared/utils.test.ts`

Expected: FAIL — Error: Cannot find module './utils.js' (or similar import error).

- [ ] **Step 4: Write minimal implementation**

Create `src/shared/utils.ts`:

```typescript
import { randomUUID } from 'node:crypto'

/** Generate a UUID v4 string. */
function generateId(): string {
  return randomUUID()
}

/** Current timestamp in milliseconds since epoch. */
function now(): number {
  return Date.now()
}

export { generateId, now }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/shared/utils.test.ts`

Expected: PASS — 4 tests passed.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts src/shared/utils.ts src/shared/utils.test.ts
git commit -m "feat: add shared utilities (generateId, now) with vitest setup"
```

---

### Task 4: Shared Base Types

**Files:**
- Create: `src/shared/types/base.ts`
- Create: `src/shared/types/base.test.ts`

- [ ] **Step 1: Write the type file**

Create `src/shared/types/base.ts`:

```typescript
/**
 * JSON Schema type (draft-07 compatible subset).
 * Used for tool parameter schemas and config schemas.
 */
type JSONSchema = {
  type?: string
  properties?: Record<string, JSONSchema>
  required?: string[]
  items?: JSONSchema | JSONSchema[]
  description?: string
  enum?: unknown[]
  additionalProperties?: boolean | JSONSchema
  allOf?: JSONSchema[]
  anyOf?: JSONSchema[]
  oneOf?: JSONSchema[]
  $ref?: string
  default?: unknown
  examples?: unknown[]
  [key: string]: unknown
}

/** Role of a message in a conversation. */
type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

/**
 * Lightweight session reference.
 * Used by ToolContext and other cross-package types to avoid
 * importing the full Session type from the session package.
 */
type SessionRef = {
  id: string
  cwd: string
}

export type { JSONSchema, MessageRole, SessionRef }
```

- [ ] **Step 2: Write the test**

Create `src/shared/types/base.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import type { JSONSchema, MessageRole, SessionRef } from './base.js'

describe('JSONSchema', () => {
  it('allows a simple object schema', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    }
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['path'])
  })

  it('allows nested schemas', () => {
    const schema: JSONSchema = {
      type: 'array',
      items: {
        type: 'string',
      },
    }
    expect(schema.items).toEqual({ type: 'string' })
  })
})

describe('MessageRole', () => {
  it('accepts all valid roles', () => {
    const roles: MessageRole[] = ['user', 'assistant', 'system', 'tool']
    expect(roles).toHaveLength(4)
  })
})

describe('SessionRef', () => {
  it('creates a session reference', () => {
    const ref: SessionRef = { id: 'sess-1', cwd: '/home/user/project' }
    expect(ref.id).toBe('sess-1')
    expect(ref.cwd).toBe('/home/user/project')
  })
})
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`

Expected: No errors.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/shared/types/base.test.ts`

Expected: PASS — 4 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/base.ts src/shared/types/base.test.ts
git commit -m "feat: add shared base types (JSONSchema, MessageRole, SessionRef)"
```

---

### Task 5: Shared Tool Types

**Files:**
- Create: `src/shared/types/tool.ts`
- Create: `src/shared/types/tool.test.ts`

- [ ] **Step 1: Write the type file**

Create `src/shared/types/tool.ts`:

```typescript
import type { JSONSchema, SessionRef } from './base.js'

/** Permission level for tool execution. */
type ToolPermission = 'auto' | 'ask' | 'deny'

/** Result of a tool execution. Discriminated by `_tag`. */
type ToolResult =
  | { _tag: 'success'; output: string; metadata?: Record<string, unknown> }
  | { _tag: 'error'; error: string }
  | { _tag: 'permission_required'; reason: string }
  | { _tag: 'truncated'; output: string; truncated: boolean; totalLines: number }

/** Context passed to every tool executor. */
type ToolContext = {
  cwd: string
  session: SessionRef
  abort: AbortSignal
  mode?: string
}

/** Function signature for tool execution. */
type ToolExecutor = (input: unknown, ctx: ToolContext) => Promise<ToolResult>

/** Optional execution mode for tools with multiple implementations. */
type ToolMode = {
  name: string
  description: string
  isAvailable: (ctx: ToolContext) => boolean
}

/** Complete tool definition registered with the tool registry. */
type ToolDef = {
  name: string
  description: string
  parameters: JSONSchema
  permission: ToolPermission
  execute: ToolExecutor
  timeout?: number
  modes?: ToolMode[]
}

export type {
  ToolPermission,
  ToolResult,
  ToolContext,
  ToolExecutor,
  ToolMode,
  ToolDef,
}
```

- [ ] **Step 2: Write the test**

Create `src/shared/types/tool.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import type {
  ToolPermission,
  ToolResult,
  ToolContext,
  ToolDef,
} from './tool.js'

describe('ToolResult', () => {
  it('creates a success result', () => {
    const result: ToolResult = {
      _tag: 'success',
      output: 'file contents here',
    }
    expect(result._tag).toBe('success')
  })

  it('creates an error result', () => {
    const result: ToolResult = { _tag: 'error', error: 'File not found' }
    expect(result._tag).toBe('error')
  })

  it('creates a permission_required result', () => {
    const result: ToolResult = {
      _tag: 'permission_required',
      reason: 'bash requires confirmation',
    }
    expect(result._tag).toBe('permission_required')
  })

  it('creates a truncated result', () => {
    const result: ToolResult = {
      _tag: 'truncated',
      output: '...',
      truncated: true,
      totalLines: 5000,
    }
    expect(result._tag).toBe('truncated')
  })
})

describe('ToolPermission', () => {
  it('accepts all permission levels', () => {
    const perms: ToolPermission[] = ['auto', 'ask', 'deny']
    expect(perms).toHaveLength(3)
  })
})

describe('ToolDef', () => {
  it('creates a minimal tool definition', () => {
    const tool: ToolDef = {
      name: 'read',
      description: 'Read a file',
      parameters: { type: 'object', properties: {} },
      permission: 'auto',
      execute: async () => ({ _tag: 'success', output: 'ok' }),
    }
    expect(tool.name).toBe('read')
    expect(tool.permission).toBe('auto')
  })

  it('creates a tool definition with timeout and modes', () => {
    const tool: ToolDef = {
      name: 'edit',
      description: 'Edit a file',
      parameters: { type: 'object' },
      permission: 'ask',
      execute: async () => ({ _tag: 'success', output: 'ok' }),
      timeout: 30_000,
      modes: [
        {
          name: 'diff',
          description: 'Standard diff mode',
          isAvailable: () => true,
        },
      ],
    }
    expect(tool.timeout).toBe(30_000)
    expect(tool.modes).toHaveLength(1)
  })
})

describe('ToolContext', () => {
  it('creates a tool context', () => {
    const ctx: ToolContext = {
      cwd: '/home/user/project',
      session: { id: 'sess-1', cwd: '/home/user/project' },
      abort: new AbortController().signal,
    }
    expect(ctx.session.id).toBe('sess-1')
  })
})
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`

Expected: No errors.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/shared/types/tool.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/tool.ts src/shared/types/tool.test.ts
git commit -m "feat: add shared tool types (ToolDef, ToolResult, ToolContext)"
```

---

### Task 6: Shared LLM Types

**Files:**
- Create: `src/shared/types/llm.ts`
- Create: `src/shared/types/llm.test.ts`

- [ ] **Step 1: Write the type file**

Create `src/shared/types/llm.ts`:

```typescript
import type { JSONSchema } from './base.js'

/** Supported LLM provider protocols. */
type ProviderProtocol = 'openai' | 'anthropic' | 'google' | 'openai-compat'

/** Provider configuration entry. */
type ProviderConfig = {
  name: string
  protocol: ProviderProtocol
  apiKey: string
  baseURL?: string
  models?: Record<string, ModelOverride>
}

/** Per-model configuration overrides. */
type ModelOverride = {
  contextWindow?: number
  maxOutput?: number
  supportsTools?: boolean
  supportsVision?: boolean
  supportsThinking?: boolean
  costPer1kInput?: number
  costPer1kOutput?: number
}

/** Static model capability descriptor. */
type ModelCapabilities = {
  contextWindow: number
  maxOutput: number
  supportsTools: boolean
  supportsVision: boolean
  supportsThinking: boolean
  costPer1kInput: number
  costPer1kOutput: number
}

/** Role tag for multi-model routing. */
type ModelRole =
  | { readonly _tag: 'default' }
  | { readonly _tag: 'smol' }
  | { readonly _tag: 'slow' }
  | { readonly _tag: 'plan' }
  | { readonly _tag: 'commit' }

/** Content part for multimodal messages (text or image). */
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string }

/** Protocol-level chat message sent to the LLM provider. */
type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  toolCallId?: string
  toolCalls?: { id: string; name: string; arguments: string }[]
}

/** Tool definition as sent to the LLM provider. */
type ChatTool = {
  name: string
  description: string
  parameters: JSONSchema
}

/** Request to the LLM provider. */
type ChatRequest = {
  model: string
  messages: ChatMessage[]
  tools?: ChatTool[]
  stream: true
  maxTokens?: number
  temperature?: number
  system?: string
}

/**
 * Streaming chunk from the LLM provider.
 * Tool calls stream in three phases: start → delta(s) → end.
 * The LLM package normalizes all provider formats to this union.
 */
type StreamChunk =
  | { _tag: 'text'; text: string }
  | { _tag: 'tool_call_start'; id: string; name: string }
  | { _tag: 'tool_call_delta'; id: string; argumentsDelta: string }
  | { _tag: 'tool_call_end'; id: string; argumentsFinal?: string }
  | { _tag: 'thinking'; text: string }
  | {
      _tag: 'usage'
      inputTokens: number
      outputTokens: number
      cacheRead?: number
    }
  | { _tag: 'done' }
  | { _tag: 'error'; error: { message: string; retryable?: boolean } }

export type {
  ProviderProtocol,
  ProviderConfig,
  ModelOverride,
  ModelCapabilities,
  ModelRole,
  ContentPart,
  ChatMessage,
  ChatTool,
  ChatRequest,
  StreamChunk,
}
```

- [ ] **Step 2: Write the test**

Create `src/shared/types/llm.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import type {
  ProviderConfig,
  ChatMessage,
  ChatTool,
  ChatRequest,
  StreamChunk,
  ModelRole,
  ModelCapabilities,
  ContentPart,
} from './llm.js'

describe('ProviderConfig', () => {
  it('creates an openai-compat provider', () => {
    const config: ProviderConfig = {
      name: 'deepseek',
      protocol: 'openai-compat',
      apiKey: 'sk-xxx',
      baseURL: 'https://api.deepseek.com/v1',
    }
    expect(config.protocol).toBe('openai-compat')
  })
})

describe('ModelRole', () => {
  it('creates all role variants', () => {
    const roles: ModelRole[] = [
      { _tag: 'default' },
      { _tag: 'smol' },
      { _tag: 'slow' },
      { _tag: 'plan' },
      { _tag: 'commit' },
    ]
    expect(roles).toHaveLength(5)
  })
})

describe('ContentPart', () => {
  it('creates a text part', () => {
    const part: ContentPart = { type: 'text', text: 'hello' }
    expect(part.type).toBe('text')
  })

  it('creates an image part', () => {
    const part: ContentPart = {
      type: 'image',
      mediaType: 'image/png',
      data: 'iVBORw0KGgo=',
    }
    expect(part.type).toBe('image')
  })
})

describe('ChatMessage', () => {
  it('creates a simple text message', () => {
    const msg: ChatMessage = { role: 'user', content: 'Hello' }
    expect(msg.role).toBe('user')
  })

  it('creates a message with tool calls', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc-1', name: 'read', arguments: '{"path":"a.ts"}' }],
    }
    expect(msg.toolCalls).toHaveLength(1)
  })
})

describe('ChatTool', () => {
  it('creates a tool definition', () => {
    const tool: ChatTool = {
      name: 'read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }
    expect(tool.name).toBe('read')
  })
})

describe('ChatRequest', () => {
  it('creates a streaming request', () => {
    const req: ChatRequest = {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }
    expect(req.stream).toBe(true)
  })
})

describe('StreamChunk', () => {
  it('creates a text chunk', () => {
    const chunk: StreamChunk = { _tag: 'text', text: 'hello' }
    expect(chunk._tag).toBe('text')
  })

  it('creates a tool_call_start chunk', () => {
    const chunk: StreamChunk = {
      _tag: 'tool_call_start',
      id: 'tc-1',
      name: 'read',
    }
    expect(chunk._tag).toBe('tool_call_start')
  })

  it('creates a usage chunk', () => {
    const chunk: StreamChunk = {
      _tag: 'usage',
      inputTokens: 100,
      outputTokens: 50,
    }
    if (chunk._tag === 'usage') {
      expect(chunk.inputTokens).toBe(100)
    }
  })

  it('creates a done chunk', () => {
    const chunk: StreamChunk = { _tag: 'done' }
    expect(chunk._tag).toBe('done')
  })
})

describe('ModelCapabilities', () => {
  it('creates a capability descriptor', () => {
    const caps: ModelCapabilities = {
      contextWindow: 128_000,
      maxOutput: 16_384,
      supportsTools: true,
      supportsVision: true,
      supportsThinking: false,
      costPer1kInput: 0.005,
      costPer1kOutput: 0.015,
    }
    expect(caps.contextWindow).toBe(128_000)
  })
})
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`

Expected: No errors.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/shared/types/llm.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/llm.ts src/shared/types/llm.test.ts
git commit -m "feat: add shared LLM types (ProviderConfig, ChatRequest, StreamChunk)"
```

---

### Task 7: Shared Message Types

**Files:**
- Create: `src/shared/types/message.ts`
- Create: `src/shared/types/message.test.ts`

- [ ] **Step 1: Write the type file**

Create `src/shared/types/message.ts`:

```typescript
import type { MessageRole } from './base.js'
import type { ToolResult } from './tool.js'

/** Content variants within a single message. Discriminated by `_tag`. */
type MessageContent =
  | { _tag: 'text'; text: string }
  | { _tag: 'tool_call'; id: string; tool: string; input: unknown }
  | { _tag: 'tool_result'; id: string; tool: string; output: ToolResult }
  | { _tag: 'thinking'; text: string }
  | { _tag: 'steering'; text: string }

/** A single message in a session. Content is always an array of parts. */
type Message = {
  id: string
  sessionId: string
  role: MessageRole
  content: MessageContent[]
  tokenCount: number
  createdAt: number
}

/** Session metadata for branching and compaction tracking. */
type SessionMetadata = {
  mainThreadId?: string
  squashCount?: number
  fileSnapshots?: string[]
}

/** A conversation session (may have a parent for branching). */
type Session = {
  id: string
  title: string
  parentId: string | null
  branchPoint: number | null
  metadata: SessionMetadata
  createdAt: number
  updatedAt: number
}

export type { MessageContent, Message, SessionMetadata, Session }
```

- [ ] **Step 2: Write the test**

Create `src/shared/types/message.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import type {
  MessageContent,
  Message,
  Session,
  SessionMetadata,
} from './message.js'

describe('MessageContent', () => {
  it('creates a text content part', () => {
    const part: MessageContent = { _tag: 'text', text: 'hello world' }
    expect(part._tag).toBe('text')
  })

  it('creates a tool_call content part', () => {
    const part: MessageContent = {
      _tag: 'tool_call',
      id: 'tc-1',
      tool: 'read',
      input: { path: 'src/main.ts' },
    }
    expect(part._tag).toBe('tool_call')
  })

  it('creates a tool_result content part', () => {
    const part: MessageContent = {
      _tag: 'tool_result',
      id: 'tc-1',
      tool: 'read',
      output: { _tag: 'success', output: 'file contents' },
    }
    expect(part._tag).toBe('tool_result')
  })

  it('creates a thinking content part', () => {
    const part: MessageContent = { _tag: 'thinking', text: 'Let me analyze...' }
    expect(part._tag).toBe('thinking')
  })

  it('creates a steering content part', () => {
    const part: MessageContent = {
      _tag: 'steering',
      text: 'Use the simpler approach.',
    }
    expect(part._tag).toBe('steering')
  })
})

describe('Message', () => {
  it('creates a message with multiple content parts', () => {
    const msg: Message = {
      id: 'msg-1',
      sessionId: 'sess-1',
      role: 'assistant',
      content: [
        { _tag: 'thinking', text: 'I should read the file first.' },
        { _tag: 'text', text: 'Let me check that file.' },
      ],
      tokenCount: 42,
      createdAt: Date.now(),
    }
    expect(msg.role).toBe('assistant')
    expect(msg.content).toHaveLength(2)
  })
})

describe('SessionMetadata', () => {
  it('creates empty metadata', () => {
    const meta: SessionMetadata = {}
    expect(meta.mainThreadId).toBeUndefined()
  })

  it('creates metadata with all fields', () => {
    const meta: SessionMetadata = {
      mainThreadId: 'sess-main',
      squashCount: 3,
      fileSnapshots: ['snap-1', 'snap-2'],
    }
    expect(meta.squashCount).toBe(3)
  })
})

describe('Session', () => {
  it('creates a root session', () => {
    const session: Session = {
      id: 'sess-1',
      title: 'New Session',
      parentId: null,
      branchPoint: null,
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    expect(session.parentId).toBeNull()
  })

  it('creates a branched session', () => {
    const session: Session = {
      id: 'sess-2',
      title: 'Fork at message 5',
      parentId: 'sess-1',
      branchPoint: 5,
      metadata: { mainThreadId: 'sess-1' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    expect(session.parentId).toBe('sess-1')
    expect(session.branchPoint).toBe(5)
  })
})
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`

Expected: No errors.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/shared/types/message.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/message.ts src/shared/types/message.test.ts
git commit -m "feat: add shared message types (Message, Session, MessageContent)"
```

---

### Task 8: Shared Agent Types

**Files:**
- Create: `src/shared/types/agent.ts`
- Create: `src/shared/types/agent.test.ts`

- [ ] **Step 1: Write the type file**

Create `src/shared/types/agent.ts`:

```typescript
import type { SessionRef } from './base.js'
import type { ToolDef, ToolResult } from './tool.js'
import type { Message, Session } from './message.js'
import type {
  ChatMessage,
  ChatTool,
  StreamChunk,
  ModelRole,
} from './llm.js'

/** Agent error variants. Discriminated by `_tag`. */
type AgentError =
  | { _tag: 'aborted' }
  | { _tag: 'max_turns'; maxTurns: number }
  | { _tag: 'unexpected'; message: string }
  | { _tag: 'provider'; message: string; retryable: boolean }
  | { _tag: 'tool'; toolName: string; message: string }

/** A tool call awaiting user permission. */
type PendingToolCall = {
  id: string
  tool: string
  input: unknown
}

/** Agent run-time status. Discriminated by `_tag`. */
type AgentStatus =
  | { _tag: 'idle' }
  | { _tag: 'running'; currentTool?: string; turnCount: number }
  | { _tag: 'paused'; pauseReason: string; pendingToolCall?: PendingToolCall }
  | {
      _tag: 'stopped'
      reason: 'completed' | 'aborted' | 'error'
      error?: AgentError
    }

/** Configuration for creating an agent. */
type AgentConfig = {
  provider: string
  model: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  tools: string[]
  plugins: string[]
  maxTurns?: number
}

/** Token budget for context window management. */
type TokenBudget = {
  total: number
  reserved: number
  available: number
  used: number
  keepRecent: number
}

/** Detailed record of a single LLM API call (for transparency/observability). */
type LLMDetail = {
  id: string
  timestamp: number
  model: string
  provider: string
  role: ModelRole
  systemPrompt: string
  messages: ChatMessage[]
  tools: ChatTool[]
  responseChunks: StreamChunk[]
  thinking?: string
  usage: { input: number; output: number; cacheRead?: number }
  latency: { firstToken: number; total: number }
  cost: number
}

/** Events emitted by the agent loop. Discriminated by `_tag`. */
type AgentEvent =
  | { _tag: 'status_change'; status: AgentStatus }
  | { _tag: 'text_delta'; text: string }
  | { _tag: 'tool_call_start'; id: string; tool: string; input: unknown }
  | { _tag: 'tool_call_progress'; id: string; progress: string }
  | { _tag: 'tool_call_end'; id: string; result: ToolResult }
  | {
      _tag: 'tool_calls_parallel'
      calls: { id: string; tool: string; input: unknown }[]
    }
  | { _tag: 'thinking'; text: string }
  | { _tag: 'usage'; input: number; output: number; cacheRead?: number }
  | {
      _tag: 'permission_required'
      toolCallId: string
      tool: string
      input: unknown
    }
  | { _tag: 'error'; error: AgentError }
  | { _tag: 'done' }

/**
 * Mutable agent state.
 * Per the data+functions paradigm, the context object may be modified in place.
 */
type AgentState = {
  id: string
  session: Session
  messages: Message[]
  tools: ToolDef[]
  config: AgentConfig
  status: AgentStatus
  abortController: AbortController
  steeringQueue: string[]
  llmDetails: LLMDetail[]
  tokenBudget: TokenBudget
  compactionModel?: { provider: string; model: string }
}

export type {
  AgentError,
  PendingToolCall,
  AgentStatus,
  AgentConfig,
  TokenBudget,
  LLMDetail,
  AgentEvent,
  AgentState,
}
```

- [ ] **Step 2: Write the test**

Create `src/shared/types/agent.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import type {
  AgentError,
  AgentStatus,
  AgentConfig,
  TokenBudget,
  AgentEvent,
  AgentState,
} from './agent.js'

describe('AgentError', () => {
  it('creates an aborted error', () => {
    const error: AgentError = { _tag: 'aborted' }
    expect(error._tag).toBe('aborted')
  })

  it('creates a max_turns error', () => {
    const error: AgentError = { _tag: 'max_turns', maxTurns: 50 }
    expect(error._tag).toBe('max_turns')
  })

  it('creates a provider error', () => {
    const error: AgentError = {
      _tag: 'provider',
      message: 'Rate limited',
      retryable: true,
    }
    expect(error._tag).toBe('provider')
  })
})

describe('AgentStatus', () => {
  it('creates idle status', () => {
    const status: AgentStatus = { _tag: 'idle' }
    expect(status._tag).toBe('idle')
  })

  it('creates running status with turn count', () => {
    const status: AgentStatus = { _tag: 'running', turnCount: 3 }
    if (status._tag === 'running') {
      expect(status.turnCount).toBe(3)
    }
  })

  it('creates paused status', () => {
    const status: AgentStatus = {
      _tag: 'paused',
      pauseReason: 'User requested pause',
    }
    if (status._tag === 'paused') {
      expect(status.pauseReason).toBe('User requested pause')
    }
  })

  it('creates stopped status', () => {
    const status: AgentStatus = { _tag: 'stopped', reason: 'completed' }
    if (status._tag === 'stopped') {
      expect(status.reason).toBe('completed')
    }
  })
})

describe('AgentConfig', () => {
  it('creates a minimal config', () => {
    const config: AgentConfig = {
      provider: 'openai',
      model: 'gpt-4.1',
      tools: ['read', 'write', 'bash'],
      plugins: [],
    }
    expect(config.model).toBe('gpt-4.1')
  })
})

describe('TokenBudget', () => {
  it('creates a token budget', () => {
    const budget: TokenBudget = {
      total: 128_000,
      reserved: 25_600,
      available: 102_400,
      used: 50_000,
      keepRecent: 10,
    }
    expect(budget.available).toBe(102_400)
  })
})

describe('AgentEvent', () => {
  it('creates a text_delta event', () => {
    const event: AgentEvent = { _tag: 'text_delta', text: 'hello' }
    expect(event._tag).toBe('text_delta')
  })

  it('creates a tool_call_start event', () => {
    const event: AgentEvent = {
      _tag: 'tool_call_start',
      id: 'tc-1',
      tool: 'read',
      input: { path: 'a.ts' },
    }
    expect(event._tag).toBe('tool_call_start')
  })

  it('creates a usage event', () => {
    const event: AgentEvent = {
      _tag: 'usage',
      input: 1500,
      output: 200,
    }
    if (event._tag === 'usage') {
      expect(event.input).toBe(1500)
    }
  })

  it('creates a permission_required event', () => {
    const event: AgentEvent = {
      _tag: 'permission_required',
      toolCallId: 'tc-1',
      tool: 'bash',
      input: { command: 'rm -rf /' },
    }
    expect(event._tag).toBe('permission_required')
  })

  it('creates a done event', () => {
    const event: AgentEvent = { _tag: 'done' }
    expect(event._tag).toBe('done')
  })
})

describe('AgentState', () => {
  it('creates a minimal agent state', () => {
    const state: AgentState = {
      id: 'agent-1',
      session: {
        id: 'sess-1',
        title: 'Test',
        parentId: null,
        branchPoint: null,
        metadata: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      messages: [],
      tools: [],
      config: {
        provider: 'openai',
        model: 'gpt-4.1',
        tools: [],
        plugins: [],
      },
      status: { _tag: 'idle' },
      abortController: new AbortController(),
      steeringQueue: [],
      llmDetails: [],
      tokenBudget: {
        total: 128_000,
        reserved: 0,
        available: 128_000,
        used: 0,
        keepRecent: 10,
      },
    }
    expect(state.status._tag).toBe('idle')
    expect(state.messages).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`

Expected: No errors.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/shared/types/agent.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/agent.ts src/shared/types/agent.test.ts
git commit -m "feat: add shared agent types (AgentState, AgentEvent, AgentStatus)"
```

---

### Task 9: Shared Config Types

**Files:**
- Create: `src/shared/types/config.ts`
- Create: `src/shared/types/config.test.ts`

- [ ] **Step 1: Write the type file**

Create `src/shared/types/config.ts`:

```typescript
import type { ProviderConfig } from './llm.js'

/** MCP server configuration. */
type MCPServerConfig = {
  name: string
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
}

/** Context compaction configuration. */
type CompactionConfig = {
  enabled: boolean
  /** Token usage ratio that triggers compaction (e.g. 0.8 = 80%). */
  threshold: number
  /** Token space to reserve after compaction. */
  reserveTokens: number
  /** Token budget for retaining recent messages verbatim. */
  keepRecentTokens: number
}

/** Global application configuration. */
type Config = {
  providers: ProviderConfig[]
  defaultProvider: string
  defaultModel: string
  roleRouting: Record<string, { provider: string; model: string }>
  fallback: { enabled: boolean; maxRetries: number; retryDelay: number }
  compaction: CompactionConfig
  tools: { enabled: string[]; disabled: string[] }
  plugins: { enabled: string[] }
  mcpServers: MCPServerConfig[]
  slashCommands: { enabled: string[] }
  theme: 'light' | 'dark' | 'system'
  locale: string
}

export type { MCPServerConfig, CompactionConfig, Config }
```

- [ ] **Step 2: Write the test**

Create `src/shared/types/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import type { Config, CompactionConfig, MCPServerConfig } from './config.js'

describe('MCPServerConfig', () => {
  it('creates a stdio server config', () => {
    const config: MCPServerConfig = {
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
    }
    expect(config.transport).toBe('stdio')
  })

  it('creates an http server config', () => {
    const config: MCPServerConfig = {
      name: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com/sse',
    }
    expect(config.transport).toBe('http')
  })
})

describe('CompactionConfig', () => {
  it('creates a compaction config', () => {
    const config: CompactionConfig = {
      enabled: true,
      threshold: 0.8,
      reserveTokens: 4096,
      keepRecentTokens: 8192,
    }
    expect(config.threshold).toBe(0.8)
  })

  it('creates a disabled compaction config', () => {
    const config: CompactionConfig = {
      enabled: false,
      threshold: 0.8,
      reserveTokens: 4096,
      keepRecentTokens: 8192,
    }
    expect(config.enabled).toBe(false)
  })
})

describe('Config', () => {
  it('creates a full config', () => {
    const config: Config = {
      providers: [
        {
          name: 'openai',
          protocol: 'openai',
          apiKey: 'sk-xxx',
        },
      ],
      defaultProvider: 'openai',
      defaultModel: 'gpt-4.1',
      roleRouting: {
        default: { provider: 'openai', model: 'gpt-4.1' },
        smol: { provider: 'openai', model: 'gpt-4.1-mini' },
      },
      fallback: { enabled: true, maxRetries: 3, retryDelay: 1000 },
      compaction: {
        enabled: true,
        threshold: 0.8,
        reserveTokens: 4096,
        keepRecentTokens: 8192,
      },
      tools: { enabled: ['read', 'write', 'bash'], disabled: [] },
      plugins: { enabled: [] },
      mcpServers: [],
      slashCommands: { enabled: ['compact', 'model', 'clear'] },
      theme: 'dark',
      locale: 'zh-CN',
    }
    expect(config.defaultProvider).toBe('openai')
    expect(config.roleRouting.smol?.model).toBe('gpt-4.1-mini')
  })
})
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`

Expected: No errors.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/shared/types/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/config.ts src/shared/types/config.test.ts
git commit -m "feat: add shared config types (Config, CompactionConfig, MCPServerConfig)"
```

---

### Task 10: Barrel Exports + Package Skeleton

**Files:**
- Create: `src/shared/types/index.ts`
- Create: `src/shared/index.ts`
- Create: `src/core/index.ts`
- Create: `src/llm/index.ts`
- Create: `src/tools/index.ts`
- Create: `src/mcp/index.ts`
- Create: `src/plugins/index.ts`
- Create: `src/session/index.ts`
- Create: `src/db/index.ts`
- Create: `src/server/index.ts`
- Create: `src/web/index.ts`
- Create: `src/cli/index.ts`

- [ ] **Step 1: Create `src/shared/types/index.ts`**

This barrel re-exports all shared types using `export type *` (required by `verbatimModuleSyntax`):

```typescript
export type * from './base.js'
export type * from './tool.js'
export type * from './llm.js'
export type * from './message.js'
export type * from './agent.js'
export type * from './config.js'
```

- [ ] **Step 2: Create `src/shared/index.ts`**

```typescript
export type * from './types/index.js'
export { generateId, now } from './utils.js'
```

- [ ] **Step 3: Create package skeleton files**

Each package gets a placeholder `index.ts` that will be filled in by subsequent plans. Create the following files, each with identical content:

`src/core/index.ts`:
```typescript
// Core package: agent loop, prompt building, config, context management.
// Implementation in subsequent plan.
export {}
```

`src/llm/index.ts`:
```typescript
// LLM package: provider abstraction, streaming, token billing.
// Implementation in subsequent plan.
export {}
```

`src/tools/index.ts`:
```typescript
// Tools package: tool registry, executor, builtin tools.
// Implementation in subsequent plan.
export {}
```

`src/mcp/index.ts`:
```typescript
// MCP package: MCP protocol client, tool adapter.
// Implementation in subsequent plan.
export {}
```

`src/plugins/index.ts`:
```typescript
// Plugins package: plugin loading, lifecycle, hook system.
// Implementation in subsequent plan.
export {}
```

`src/session/index.ts`:
```typescript
// Session package: session persistence, branching, compaction.
// Implementation in subsequent plan.
export {}
```

`src/db/index.ts`:
```typescript
// DB package: Drizzle schema, PGLite/PostgreSQL client, migrations.
// Implementation in subsequent plan.
export {}
```

`src/server/index.ts`:
```typescript
// Server package: Hono API + SSE streaming.
// Implementation in subsequent plan.
export {}
```

`src/web/index.ts`:
```typescript
// Web package: React frontend.
// Implementation in subsequent plan.
export {}
```

`src/cli/index.ts`:
```typescript
// CLI package: c0de command entry point.
// Implementation in subsequent plan.
export {}
```

- [ ] **Step 4: Run full typecheck**

Run: `pnpm typecheck`

Expected: No errors. All skeleton files and barrel exports compile.

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`

Expected: All tests pass (utils + all 6 type test files).

- [ ] **Step 6: Run linter**

Run: `pnpm lint`

Expected: No errors or warnings.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types/index.ts src/shared/index.ts src/core/index.ts src/llm/index.ts src/tools/index.ts src/mcp/index.ts src/plugins/index.ts src/session/index.ts src/db/index.ts src/server/index.ts src/web/index.ts src/cli/index.ts
git commit -m "feat: add barrel exports and package skeleton for all modules"
```

---

## Self-Review

### 1. Spec Coverage

| Spec section | Coverage | Task |
|---|---|---|
| §2 Package structure (directories) | ✅ | Task 10 |
| §3.2 Core types (AgentConfig, AgentState, AgentEvent) | ✅ | Task 8 |
| §3.5 Config type | ✅ | Task 9 |
| §3.6 TokenBudget | ✅ | Task 8 |
| §3.7 AgentError | ✅ | Task 8 |
| §3.9 Steering (MessageContent.steering) | ✅ | Task 7 |
| §4.3 LLM types (ChatMessage, ChatTool, ChatRequest, StreamChunk) | ✅ | Task 6 |
| §4.5 ModelCapabilities | ✅ | Task 6 |
| §4.6 ModelRole | ✅ | Task 6 |
| §5.2 Tool types (ToolDef, ToolResult, ToolPermission, ToolContext) | ✅ | Task 5 |
| §5.3 ToolExecutor, ToolMode | ✅ | Task 5 |
| §6.2 MCPServerConfig | ✅ | Task 9 |
| §8 Session/Message types | ✅ | Task 7 |
| §8.2 SessionMetadata | ✅ | Task 7 |
| §13 Data+functions paradigm | ✅ | All tasks (type + export function) |
| §20.1 LLMDetail | ✅ | Task 8 |

**Gaps:** None for the Foundation scope. Implementation of each package's behavior is intentionally deferred to subsequent plans.

### 2. Placeholder Scan

Searched for: TBD, TODO, "implement later", "fill in details", "add appropriate", "similar to Task", "handle edge cases".

**Result:** No placeholders found. All code blocks contain complete implementations.

The `export {}` in skeleton files is intentional — it marks the file as an ESM module with no exports yet. This is standard TypeScript, not a placeholder.

### 3. Type Consistency

Cross-checked all type names across tasks:

- `ToolResult` — defined Task 5 (tool.ts), used Task 7 (message.ts), Task 8 (agent.ts) ✅
- `SessionRef` — defined Task 4 (base.ts), used Task 5 (tool.ts) ✅
- `Message` — defined Task 7 (message.ts), used Task 8 (agent.ts) ✅
- `Session` — defined Task 7 (message.ts), used Task 8 (agent.ts) ✅
- `ToolDef` — defined Task 5 (tool.ts), used Task 8 (agent.ts) ✅
- `ChatMessage`, `ChatTool`, `StreamChunk`, `ModelRole` — defined Task 6 (llm.ts), used Task 8 (agent.ts) ✅
- `ProviderConfig` — defined Task 6 (llm.ts), used Task 9 (config.ts) ✅
- `AgentStatus`, `AgentEvent`, `AgentError`, `AgentState`, `AgentConfig`, `TokenBudget`, `LLMDetail` — defined Task 8 (agent.ts) ✅
- `Config`, `CompactionConfig`, `MCPServerConfig` — defined Task 9 (config.ts) ✅
- All imports use `.js` extensions (NodeNext requirement) ✅
- All type-only imports use `import type` (verbatimModuleSyntax requirement) ✅

No inconsistencies found.
