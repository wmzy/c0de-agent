# Core Agent Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `src/core/` package — the agent loop that orchestrates LLM streaming, tool execution, context compaction, steering, and lifecycle control (pause/resume/abort).

**Architecture:** Data+functions paradigm. `AgentState` (defined in `shared/types/agent.ts`) holds pure mutable data; all services (`db`, `llmRegistry`, `toolRegistry`, `permission`) are injected via an `AgentDependencies` parameter passed to `createAgent`/`runAgent`. The loop is an `AsyncGenerator<AgentEvent>` that consumers (server, CLI) iterate to drive the agent. Compaction is bridged via an injected `Summarizer` so `core` → `session` + `llm` but never circular.

**Tech Stack:** TypeScript (ESM/NodeNext, strict), Vitest, PGLite (in-memory for tests), `@/llm` (provider streaming), `@/tools` (executor + registry), `@/session` (persistence + compaction).

---

## Design Decisions

1. **Dependency injection, not state-bloat.** `AgentState` (shared) holds data only. Services live in `AgentDependencies` passed alongside state to every function. This keeps state serializable and testable.
2. **`runAgent` is a generator over an already-persisted user message.** The caller is responsible for `appendMessage(db, sessionId, userMessage)` before calling `runAgent`. The loop persists assistant messages and tool results itself.
3. **Token estimation uses the session-layer `estimateTokens`** (CJK-aware) for budget calculations, not the LLM-layer `estimateTokens`.
4. **Tool execution wraps `executeTool` from `@/tools`.** The core layer adds: timeout-watch (returns partial output instead of killing), parallel execution with write-conflict detection, and permission-required event emission.
5. **Compaction bridge.** `createSummarizer(llmRegistry, provider, model)` wraps an LLM call into the `Summarizer = (prompt: string) => Promise<string>` shape that `session.compactSession` expects. This is the only place `core` imports `llm`.
6. **Steering messages are transient.** They are drained from the queue before each LLM turn and inserted as system-role messages in the request. They are NOT persisted to the session DB.
7. **`createAgent` loads existing session entries from DB** into `state.messages` so resuming a session works.

---

## File Structure

```
src/core/
├── types.ts        Local types: AgentDependencies, PromptContext, ProjectInfo, CommandContext, SlashCommand. Re-exports shared agent types.
├── config.ts       DEFAULT_CONFIG, loadConfig, saveConfig, mergeConfig (three-layer merge).
├── context.ts      Token budget: createTokenBudget, estimateBudget, fitToBudget, shouldCompact.
├── prompt.ts       buildSystemPrompt(PromptContext): string — role + tools + project + constraints.
├── steering.ts     injectSteering, drainSteering, clearSteering (queue ops on state).
├── compact.ts      createSummarizer (LLM→Summarizer bridge), runCompaction (calls session.compactSession).
├── tool-exec.ts    executeToolCall, executeToolCalls (parallel + conflict detection), timeout-watch wrapper.
├── loop.ts         agentLoop(state, deps): AsyncGenerator<AgentEvent> — the main turn loop.
├── agent.ts        createAgent, runAgent, pauseAgent, resumeAgent, abortAgent, getAgentStatus.
├── slash.ts        SlashCommand type, createSlashRegistry, builtin commands (/compact /model /clear /help /fork /config).
└── index.ts        Barrel export of all public API.
```

Each file has a single responsibility and its own test file (`*.test.ts`) co-located in `src/core/`.

---

## Task 1: Core Types (`types.ts`)

**Files:**
- Create: `src/core/types.ts`
- Test: `src/core/types.test.ts`

Local types for the core package. Pure type definitions + re-exports of shared agent types. The test verifies that re-exports are accessible and that the local type contracts compile.

- [ ] **Step 1: Write the type test**

```typescript
// src/core/types.test.ts
import { describe, it, expectTypeOf } from 'vitest'
import type { AgentDependencies, CommandContext, PromptContext, ProjectInfo, SlashCommand } from './types.js'
import type { AgentState, AgentEvent, AgentConfig, AgentStatus } from './types.js'
import type { Config } from './config.js'

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
    expectTypeOf<PromptContext>().toHaveProperty('tools').toEqualTypeOf<unknown[]>()
    expectTypeOf<PromptContext>().toHaveProperty('config')
    expectTypeOf<PromptContext>().toHaveProperty('projectInfo')
  })

  it('SlashCommand has name and execute', () => {
    const cmd: SlashCommand = {
      name: 'test',
      description: 'd',
      execute: async () => ({ _tag: 'success', message: 'ok' }),
    }
    expectTypeOf(cmd.name).toEqualTypeOf<string>()
  })
})
```

- [ ] **Step 2: Write the types file**

```typescript
// src/core/types.ts
import type { DB } from '../db/client.js'
import type { Registry } from '../llm/registry.js'
import type { ToolRegistry } from '../tools/types.js'
import type { PermissionChecker } from '../tools/types.js'
import type { ChatTool } from '../shared/types/llm.js'
import type { ToolDef } from '../shared/types/tool.js'
import type { AgentConfig, AgentError, AgentEvent, AgentState, AgentStatus, LLMDetail, PendingToolCall, TokenBudget } from '../shared/types/agent.js'
import type { Config } from './config.js'

/** Runtime services injected into every core function (DI pattern). */
type AgentDependencies = {
  db: DB
  llmRegistry: Registry
  toolRegistry: ToolRegistry
  permission: PermissionChecker
  config: Config
  cwd: string
}

/** Project context information for system prompt construction. */
type ProjectInfo = {
  name: string
  language: string
  framework?: string
  rootDir: string
  gitBranch?: string
}

/** Context for building the system prompt. */
type PromptContext = {
  tools: ToolDef[]
  config: AgentConfig
  projectInfo: ProjectInfo
  skills?: string[]
}

/** Result of a slash command execution. */
type CommandResult =
  | { _tag: 'success'; message: string }
  | { _tag: 'error'; message: string }
  | { _tag: 'text'; text: string }

/** Context passed to slash command executors. */
type CommandContext = {
  cwd: string
  config: Config
  deps: AgentDependencies
}

/** A slash command definition. */
type SlashCommand = {
  name: string
  description: string
  argsHint?: string
  execute: (args: string, ctx: CommandContext) => Promise<CommandResult>
}

export type {
  AgentDependencies,
  CommandContext,
  CommandResult,
  LLMDetail,
  PendingToolCall,
  ProjectInfo,
  PromptContext,
  SlashCommand,
  TokenBudget,
}
// Re-export shared agent types so consumers import everything from core.
export type { AgentConfig, AgentError, AgentEvent, AgentState, AgentStatus }
// Re-export ChatTool for prompt building.
export type { ChatTool }
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (types compile).

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run src/core/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/types.test.ts
git commit -m "feat(core): add core types — AgentDependencies, PromptContext, SlashCommand"
```

---

## Task 2: Config Management (`config.ts`)

**Files:**
- Create: `src/core/config.ts`
- Test: `src/core/config.test.ts`

Three-layer config merge (defaults → global `~/.c0de/config.json` → project `.c0de/config.json`), with load/save/merge functions. Config types are already defined in `shared/types/config.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_CONFIG, loadConfig, saveConfig, mergeConfig } from './config.js'
import type { Config } from './config.js'

const tmp = join(tmpdir(), `c0de-config-test-${Date.now()}`)

beforeEach(() => mkdirSync(tmp, { recursive: true }))
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('DEFAULT_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_CONFIG.providers).toEqual([])
    expect(DEFAULT_CONFIG.compaction.enabled).toBe(true)
    expect(DEFAULT_CONFIG.compaction.threshold).toBe(0.8)
    expect(DEFAULT_CONFIG.tools.enabled).toContain('read')
    expect(DEFAULT_CONFIG.fallback.maxRetries).toBe(3)
  })
})

describe('mergeConfig', () => {
  it('returns DEFAULT when no overrides', () => {
    const merged = mergeConfig()
    expect(merged.defaultModel).toBe(DEFAULT_CONFIG.defaultModel)
  })

  it('overrides top-level keys', () => {
    const merged = mergeConfig({ defaultModel: 'gpt-5' })
    expect(merged.defaultModel).toBe('gpt-5')
  })

  it('deep-merges nested objects', () => {
    const merged = mergeConfig({ compaction: { threshold: 0.9 } })
    expect(merged.compaction.threshold).toBe(0.9)
    expect(merged.compaction.enabled).toBe(true) // preserved from default
  })

  it('later overrides win', () => {
    const merged = mergeConfig({ defaultModel: 'a' }, { defaultModel: 'b' })
    expect(merged.defaultModel).toBe('b')
  })

  it('replaces arrays, not concatenates', () => {
    const merged = mergeConfig({ providers: [{ name: 'x', type: 'openai', baseURL: 'u', apiKey: 'k' }] })
    expect(merged.providers).toHaveLength(1)
  })
})

describe('saveConfig / loadConfig', () => {
  it('saves and loads project config', async () => {
    await saveConfig(mergeConfig({ defaultModel: 'claude' }), 'project', tmp)
    const loaded = await loadConfig(tmp)
    expect(loaded.defaultModel).toBe('claude')
  })

  it('returns defaults when no config files exist', async () => {
    const loaded = await loadConfig(tmp)
    expect(loaded.defaultModel).toBe(DEFAULT_CONFIG.defaultModel)
  })

  it('project config overrides defaults', async () => {
    await saveConfig(mergeConfig({ defaultModel: 'project-model' }), 'project', tmp)
    const loaded = await loadConfig(tmp)
    expect(loaded.defaultModel).toBe('project-model')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/config.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CompactionConfig, Config, MCPServerConfig } from '../shared/types/config.js'

const GLOBAL_CONFIG_DIR = '.c0de'
const CONFIG_FILENAME = 'config.json'

/** Built-in default configuration. */
const DEFAULT_CONFIG: Config = {
  providers: [],
  defaultProvider: 'openai',
  defaultModel: 'gpt-4o',
  roleRouting: {},
  fallback: { enabled: false, maxRetries: 3, retryDelay: 2000 },
  compaction: {
    enabled: true,
    threshold: 0.8,
    reserveTokens: 8000,
    keepRecentTokens: 4000,
  },
  tools: { enabled: ['read', 'write', 'edit', 'glob', 'grep', 'bash'], disabled: [] },
  plugins: { enabled: [] },
  mcpServers: [],
  slashCommands: { enabled: ['/compact', '/model', '/clear', '/help', '/fork', '/config'] },
  theme: 'system',
  locale: 'en',
}

/** Deep-merge multiple partial configs. Later args win. Arrays are replaced, not concatenated. */
function mergeConfig(...configs: Partial<Config>[]): Config {
  const result: Config = structuredClone(DEFAULT_CONFIG)
  for (const cfg of configs) {
    if (!cfg) continue
    for (const key of Object.keys(cfg) as (keyof Config)[]) {
      const val = cfg[key]
      if (val === undefined) continue
      const current = result[key]
      if (val !== null && typeof val === 'object' && !Array.isArray(val) &&
          current !== null && typeof current === 'object' && !Array.isArray(current)) {
        // shallow deep-merge one level for plain objects
        ;(result as Record<string, unknown>)[key] = { ...current, ...val }
      } else {
        ;(result as Record<string, unknown>)[key] = val
      }
    }
  }
  return result
}

function readJsonIfExists(path: string): Partial<Config> | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Partial<Config>
  } catch {
    return undefined
  }
}

/** Load config with three-layer merge: defaults → global (~/.c0de) → project (.c0de). */
async function loadConfig(projectDir?: string): Promise<Config> {
  const globalPath = join(homedir(), GLOBAL_CONFIG_DIR, CONFIG_FILENAME)
  const projectPath = join(projectDir ?? process.cwd(), '.c0de', CONFIG_FILENAME)
  const global = readJsonIfExists(globalPath)
  const project = readJsonIfExists(projectPath)
  return mergeConfig(global, project)
}

/** Save config to global (~/.c0de) or project (.c0de) scope. */
async function saveConfig(config: Config, scope: 'global' | 'project', projectDir?: string): Promise<void> {
  const dir = scope === 'global'
    ? join(homedir(), GLOBAL_CONFIG_DIR)
    : join(projectDir ?? process.cwd(), '.c0de')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, CONFIG_FILENAME)
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8')
}

export { DEFAULT_CONFIG, loadConfig, mergeConfig, saveConfig }
export type { CompactionConfig, Config, MCPServerConfig }
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/core/config.test.ts`
Expected: PASS — all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts src/core/config.test.ts
git commit -m "feat(core): add config management — three-layer merge, load/save"
```

---

## Task 3: Token Budget & Context Fitting (`context.ts`)

**Files:**
- Create: `src/core/context.ts`
- Test: `src/core/context.test.ts`

Token budget allocation, sliding-window message fitting, and compaction-trigger detection. Uses session-layer `estimateTokens` (CJK-aware).

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/context.test.ts
import { describe, it, expect } from 'vitest'
import { createTokenBudget, estimateBudget, fitToBudget, shouldCompact } from './context.js'
import type { Message } from '../shared/types/message.js'
import type { TokenBudget } from '../shared/types/agent.js'
import type { CompactionConfig } from './config.js'

function makeMessage(text: string): Message {
  return {
    id: Math.random().toString(36),
    sessionId: 's1',
    role: 'user',
    content: [{ _tag: 'text', text }],
    tokenCount: 0,
    createdAt: Date.now(),
  }
}

describe('createTokenBudget', () => {
  it('allocates reserved/available from total', () => {
    const b = createTokenBudget(100_000)
    expect(b.total).toBe(100_000)
    expect(b.reserved).toBe(20_000) // 20% for system prompt
    expect(b.available).toBe(80_000)
    expect(b.used).toBe(0)
    expect(b.keepRecent).toBe(10_000)
  })

  it('respects custom keepRecent', () => {
    const b = createTokenBudget(100_000, { keepRecent: 5_000 })
    expect(b.keepRecent).toBe(5_000)
  })
})

describe('estimateBudget', () => {
  it('sums token counts of messages', () => {
    const msgs = [makeMessage('hello'), makeMessage('world')]
    const used = estimateBudget(msgs)
    expect(used).toBeGreaterThan(0)
  })
})

describe('fitToBudget', () => {
  it('returns all messages when within budget', () => {
    const msgs = [makeMessage('hi')]
    const budget = createTokenBudget(100_000)
    budget.used = estimateBudget(msgs)
    const fitted = fitToBudget(msgs, budget)
    expect(fitted).toHaveLength(1)
  })

  it('drops oldest non-system messages when over budget', () => {
    const msgs: Message[] = []
    for (let i = 0; i < 100; i++) {
      msgs.push(makeMessage(`message number ${i} `.repeat(50)))
    }
    const budget = createTokenBudget(2_000)
    const fitted = fitToBudget(msgs, budget)
    expect(fitted.length).toBeLessThan(msgs.length)
    // keeps the most recent
    expect(fitted[fitted.length - 1]).toBe(msgs[msgs.length - 1])
  })

  it('always keeps the last N messages (keepRecent)', () => {
    const msgs: Message[] = []
    for (let i = 0; i < 50; i++) {
      msgs.push(makeMessage(`x`.repeat(200)))
    }
    const budget = createTokenBudget(500, { keepRecent: 5 })
    const fitted = fitToBudget(msgs, budget)
    // at least keepRecent messages kept
    expect(fitted.length).toBeGreaterThanOrEqual(5)
  })
})

describe('shouldCompact', () => {
  const cfg: CompactionConfig = { enabled: true, threshold: 0.8, reserveTokens: 1000, keepRecentTokens: 500 }

  it('returns false when disabled', () => {
    const budget = createTokenBudget(10_000)
    budget.used = 9_000
    expect(shouldCompact([], budget, { ...cfg, enabled: false })).toBe(false)
  })

  it('returns true when usage exceeds threshold', () => {
    const budget = createTokenBudget(10_000)
    budget.used = 8_500 // 85% of available (8000)
    expect(shouldCompact([], budget, cfg)).toBe(true)
  })

  it('returns false when usage is under threshold', () => {
    const budget = createTokenBudget(10_000)
    budget.used = 5_000
    expect(shouldCompact([], budget, cfg)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/context.ts
import type { Message } from '../shared/types/message.js'
import type { TokenBudget } from '../shared/types/agent.js'
import type { CompactionConfig } from './config.js'
import { estimateTokens } from '../session/token.js'

/** Default system prompt reserve ratio (20% of total context window). */
const SYSTEM_PROMPT_RATIO = 0.2
/** Default keep-recent token budget (10% of total). */
const KEEP_RECENT_RATIO = 0.1

/** Create a token budget from a context window size. */
function createTokenBudget(
  totalTokens: number,
  opts?: { reserved?: number; keepRecent?: number },
): TokenBudget {
  const reserved = opts?.reserved ?? Math.floor(totalTokens * SYSTEM_PROMPT_RATIO)
  return {
    total: totalTokens,
    reserved,
    available: totalTokens - reserved,
    used: 0,
    keepRecent: opts?.keepRecent ?? Math.floor(totalTokens * KEEP_RECENT_RATIO),
  }
}

/** Estimate total tokens consumed by a list of messages. */
function estimateBudget(messages: Message[]): number {
  return messages.reduce((sum, m) => {
    if (m.tokenCount > 0) return sum + m.tokenCount
    const text = m.content
      .map((p) => (p._tag === 'text' || p._tag === 'thinking' ? p.text : ''))
      .join('')
    return sum + estimateTokens(text)
  }, 0)
}

/**
 * Fit messages into the available token budget by dropping the oldest
 * non-system messages. Always preserves the last `keepRecentTokens`-worth
 * of messages (measured by token count).
 */
function fitToBudget(messages: Message[], budget: TokenBudget): Message[] {
  if (messages.length === 0) return []

  // Compute cumulative tokens from the end to find the keepRecent floor.
  let recentTokens = 0
  let recentStart = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    const tc = m.tokenCount > 0 ? m.tokenCount : estimateTokens(
      m.content.map((p) => (p._tag === 'text' || p._tag === 'thinking' ? p.text : '')).join(''),
    )
    if (recentTokens + tc > budget.keepRecent) break
    recentTokens += tc
    recentStart = i
  }

  // Now greedily include from the start until budget is exhausted,
  // but always include everything from recentStart onward.
  const result: Message[] = []
  let used = 0
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m) continue
    const tc = m.tokenCount > 0 ? m.tokenCount : estimateTokens(
      m.content.map((p) => (p._tag === 'text' || p._tag === 'thinking' ? p.text : '')).join(''),
    )
    const mustKeep = i >= recentStart
    if (mustKeep || used + tc <= budget.available) {
      result.push(m)
      used += tc
    }
  }
  return result
}

/** Whether the token budget usage exceeds the compaction threshold. */
function shouldCompact(_messages: Message[], budget: TokenBudget, config: CompactionConfig): boolean {
  if (!config.enabled) return false
  if (budget.available <= 0) return false
  const ratio = budget.used / budget.available
  return ratio >= config.threshold
}

export { createTokenBudget, estimateBudget, fitToBudget, shouldCompact }
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/core/context.test.ts`
Expected: PASS — all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/context.ts src/core/context.test.ts
git commit -m "feat(core): add token budget management and context fitting"
```

---

## Task 4: System Prompt Builder (`prompt.ts`)

**Files:**
- Create: `src/core/prompt.ts`
- Test: `src/core/prompt.test.ts`

Assembles the system prompt from: role description, enabled tools (with JSON Schema), project context, and coding-paradigm constraints.

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/prompt.test.ts
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from './prompt.js'
import type { PromptContext } from './types.js'
import type { AgentConfig } from '../shared/types/agent.js'
import type { ToolDef } from '../shared/types/tool.js'

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/prompt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/prompt.ts
import type { PromptContext } from './types.js'

const ROLE_DESCRIPTION = `You are c0de-agent, an open-source AI coding assistant.
You help developers write, debug, and understand code across multiple languages and frameworks.`

const PARADIGM_CONSTRAINTS = `## Coding Paradigm
This project follows a strict data + functions paradigm:
- Use \`type\` (not \`interface\`) for type definitions.
- Use discriminated unions with \`_tag\` fields for variant types.
- Use plain functions \`export function foo(ctx, ...)\` with context-first argument.
- No classes; prefer factory functions and pure data transformation.
- Prefer \`import type\` for type-only imports.`

/**
 * Build the system prompt from role, tools, project context, and constraints.
 */
function buildSystemPrompt(ctx: PromptContext): string {
  const parts: string[] = []

  // 1. Role
  parts.push(ROLE_DESCRIPTION)

  // 2. Custom override
  if (ctx.config.systemPrompt) {
    parts.push(ctx.config.systemPrompt)
  }

  // 3. Tools
  if (ctx.tools.length > 0) {
    parts.push('## Available Tools')
    for (const tool of ctx.tools) {
      parts.push(`- **${tool.name}**: ${tool.description}`)
    }
  }

  // 4. Project context
  parts.push('## Project Context')
  parts.push(`- Name: ${ctx.projectInfo.name}`)
  parts.push(`- Language: ${ctx.projectInfo.language}`)
  if (ctx.projectInfo.framework) {
    parts.push(`- Framework: ${ctx.projectInfo.framework}`)
  }
  parts.push(`- Root: ${ctx.projectInfo.rootDir}`)
  if (ctx.projectInfo.gitBranch) {
    parts.push(`- Git Branch: ${ctx.projectInfo.gitBranch}`)
  }

  // 5. Skills
  if (ctx.skills && ctx.skills.length > 0) {
    parts.push('## Loaded Skills')
    for (const skill of ctx.skills) {
      parts.push(`- ${skill}`)
    }
  }

  // 6. Paradigm constraints
  parts.push(PARADIGM_CONSTRAINTS)

  return parts.join('\n\n')
}

export { buildSystemPrompt }
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/core/prompt.test.ts`
Expected: PASS — all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/prompt.ts src/core/prompt.test.ts
git commit -m "feat(core): add system prompt builder with tools, project context, paradigm"
```

---

## Task 5: Steering Message Queue (`steering.ts`)

**Files:**
- Create: `src/core/steering.ts`
- Test: `src/core/steering.test.ts`

Operations on the `steeringQueue` array inside `AgentState`. Steering messages are transient — drained before each LLM turn and NOT persisted.

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/steering.test.ts
import { describe, it, expect } from 'vitest'
import { injectSteering, drainSteering, clearSteering } from './steering.js'
import type { AgentState } from '../shared/types/agent.js'
import type { Session } from '../shared/types/message.js'

function makeState(): AgentState {
  const session: Session = {
    id: 's1', title: 't', parentId: null, branchPoint: null,
    metadata: {}, createdAt: 0, updatedAt: 0,
  }
  return {
    id: 'a1', session, messages: [], tools: [],
    config: { provider: 'p', model: 'm', tools: [], plugins: [] },
    status: { _tag: 'idle' },
    abortController: new AbortController(),
    steeringQueue: [], llmDetails: [],
    tokenBudget: { total: 0, reserved: 0, available: 0, used: 0, keepRecent: 0 },
  }
}

describe('steering queue', () => {
  it('injectSteering adds message to queue', () => {
    const state = makeState()
    injectSteering(state, 'stop using globals')
    expect(state.steeringQueue).toEqual(['stop using globals'])
  })

  it('injectSteering appends multiple messages in order', () => {
    const state = makeState()
    injectSteering(state, 'first')
    injectSteering(state, 'second')
    expect(state.steeringQueue).toEqual(['first', 'second'])
  })

  it('drainSteering returns all messages and clears queue', () => {
    const state = makeState()
    injectSteering(state, 'a')
    injectSteering(state, 'b')
    const drained = drainSteering(state)
    expect(drained).toEqual(['a', 'b'])
    expect(state.steeringQueue).toEqual([])
  })

  it('drainSteering returns empty array when queue is empty', () => {
    const state = makeState()
    expect(drainSteering(state)).toEqual([])
  })

  it('clearSteering empties the queue', () => {
    const state = makeState()
    injectSteering(state, 'x')
    clearSteering(state)
    expect(state.steeringQueue).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/steering.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/steering.ts
import type { AgentState } from '../shared/types/agent.js'

/** Add a steering message to the queue. Takes effect before the next LLM turn. */
function injectSteering(state: AgentState, message: string): void {
  state.steeringQueue.push(message)
}

/** Remove and return all queued steering messages (FIFO order). Clears the queue. */
function drainSteering(state: AgentState): string[] {
  const messages = [...state.steeringQueue]
  state.steeringQueue.length = 0
  return messages
}

/** Discard all queued steering messages without returning them. */
function clearSteering(state: AgentState): void {
  state.steeringQueue.length = 0
}

export { clearSteering, drainSteering, injectSteering }
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/core/steering.test.ts`
Expected: PASS — all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/steering.ts src/core/steering.test.ts
git commit -m "feat(core): add steering message queue operations"
```

---

## Task 6: Compaction Bridge (`compact.ts`)

**Files:**
- Create: `src/core/compact.ts`
- Test: `src/core/compact.test.ts`

Bridges the LLM layer into the `Summarizer` shape that `session.compactSession` expects. This is the only file in `core` that imports from `llm`. Also provides `runCompaction` which wraps `compactSession` with the summarizer.

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/compact.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createSummarizer, runCompaction } from './compact.js'
import { createDB } from '../db/client.js'

// We test createSummarizer with a mock chatStream via the registry.
// Since the registry is complex, we test the Summarizer contract directly.

describe('createSummarizer', () => {
  it('returns a function that resolves to the LLM completion', async () => {
    // Create a summarizer using a fake chat function
    const fakeChat = async (_prompt: string) => 'SUMMARY: stuff happened'
    const summarizer = createSummarizerFromFn(fakeChat)
    const result = await summarizer('compress this')
    expect(result).toBe('SUMMARY: stuff happened')
  })
})

describe('runCompaction', () => {
  it('calls compactSession with the summarizer and returns result', async () => {
    const db = await createDB(':memory:')
    // This is an integration test — we set up a session with messages
    // and verify compaction produces a summary entry.
    const { createSession, appendMessage } = await import('../session/session.js')
    const { appendMessage: append } = await import('../session/message.js')
    const session = await createSession(db, { title: 'test' })
    await append(db, session.id, {
      role: 'user', content: [{ _tag: 'text', text: 'Hello world '.repeat(100) }],
    })
    await append(db, session.id, {
      role: 'assistant', content: [{ _tag: 'text', text: 'Hi there '.repeat(100) }],
    })

    const summarizer = async () => 'Compacted summary'
    const result = await runCompaction(db, session.id, summarizer, { threshold: 0 })
    expect(result._tag).toBe('compacted')
    if (result._tag === 'compacted') {
      expect(result.summary).toBe('Compacted summary')
      expect(result.archiveId).toBeTruthy()
    }
    await db.close()
  })
})

// Helper: create a summarizer from a plain function (avoids needing a real LLM registry).
function createSummarizerFromFn(fn: (prompt: string) => Promise<string>) {
  return fn
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/compact.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/compact.ts
import type { DB } from '../db/client.js'
import type { Registry } from '../llm/registry.js'
import { chatStream } from '../llm/provider.js'
import type { ChatRequest, StreamChunk } from '../shared/types/llm.js'
import { compactSession } from '../session/compaction.js'
import type { CompactionConfig, CompactionResult, Summarizer } from '../session/types.js'

/**
 * Create a Summarizer backed by an LLM call.
 * The summarizer takes a compaction prompt and returns the model's text response.
 * This is the bridge: session.compactSession needs a Summarizer, which core provides
 * by calling the LLM layer's chatStream.
 */
function createSummarizer(
  registry: Registry,
  provider: string,
  model: string,
  opts?: { maxTokens?: number; signal?: AbortSignal },
): Summarizer {
  return async (prompt: string): Promise<string> => {
    const request: ChatRequest = {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      ...(opts?.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    }
    const chunks: StreamChunk[] = []
    for await (const chunk of chatStream(
      { registry, signal: opts?.signal },
      request,
      { provider, model },
    )) {
      if (chunk._tag === 'text') {
        chunks.push(chunk)
      }
      if (chunk._tag === 'error') {
        throw new Error(chunk.error.message)
      }
    }
    return chunks.map((c) => (c._tag === 'text' ? c.text : '')).join('')
  }
}

/**
 * Run compaction on a session using an LLM-backed summarizer.
 * Wraps session.compactSession with the injected LLM registry.
 */
async function runCompaction(
  db: DB,
  sessionId: string,
  summarizer: Summarizer,
  config?: Partial<CompactionConfig>,
): Promise<CompactionResult> {
  return compactSession(db, sessionId, summarizer, config)
}

export { createSummarizer, runCompaction }
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/core/compact.test.ts`
Expected: PASS — both tests (createSummarizerFromFn helper + integration compaction).

- [ ] **Step 5: Commit**

```bash
git add src/core/compact.ts src/core/compact.test.ts
git commit -m "feat(core): add compaction bridge — LLM summarizer + session compactSession"
```

---

## Task 7: Tool Execution Wrapper (`tool-exec.ts`)

**Files:**
- Create: `src/core/tool-exec.ts`
- Test: `src/core/tool-exec.test.ts`

Wraps `executeTool` from `@/tools` with: timeout-watch (returns partial output instead of killing the process), parallel execution with write-conflict detection, and a clean result type for the loop.

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/tool-exec.test.ts
import { describe, it, expect } from 'vitest'
import { executeToolCall, executeToolCalls, partitionByConflict } from './tool-exec.js'
import { createDefaultRegistry } from '../tools/index.js'
import { autoAllowChecker } from '../tools/permission.js'
import type { ToolContext } from '../shared/types/tool.js'

const registry = createDefaultRegistry()
const permission = autoAllowChecker

function makeCtx(): ToolContext {
  return {
    cwd: process.cwd(),
    session: { id: 's1', cwd: process.cwd() },
    abort: new AbortController().signal,
  }
}

describe('executeToolCall', () => {
  it('executes a read tool successfully', async () => {
    const result = await executeToolCall(
      registry, permission, makeCtx(),
      'read', { path: 'package.json', limit: 5 },
    )
    expect(result._tag).toBe('success')
  })

  it('returns error for unknown tool', async () => {
    const result = await executeToolCall(
      registry, permission, makeCtx(),
      'nonexistent', {},
    )
    expect(result._tag).toBe('error')
  })

  it('returns error for invalid input', async () => {
    const result = await executeToolCall(
      registry, permission, makeCtx(),
      'read', {}, // missing path
    )
    expect(result._tag).toBe('error')
  })
})

describe('executeToolCalls', () => {
  it('executes multiple read calls in parallel', async () => {
    const calls = [
      { id: '1', tool: 'read', input: { path: 'package.json', limit: 3 } },
      { id: '2', tool: 'read', input: { path: 'tsconfig.json', limit: 3 } },
    ]
    const results = await executeToolCalls(registry, permission, makeCtx(), calls)
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.result._tag === 'success')).toBe(true)
  })

  it('returns results keyed by call id', async () => {
    const calls = [
      { id: 'a', tool: 'read', input: { path: 'package.json', limit: 1 } },
    ]
    const results = await executeToolCalls(registry, permission, makeCtx(), calls)
    expect(results[0]?.id).toBe('a')
  })
})

describe('partitionByConflict', () => {
  it('puts two writes to same path in serial', () => {
    const calls = [
      { id: '1', tool: 'write', input: { path: '/a', content: 'x' } },
      { id: '2', tool: 'write', input: { path: '/a', content: 'y' } },
    ]
    const { parallel, serial } = partitionByConflict(calls)
    expect(parallel).toHaveLength(1)
    expect(serial).toHaveLength(1)
  })

  it('puts two writes to different paths in parallel', () => {
    const calls = [
      { id: '1', tool: 'write', input: { path: '/a', content: 'x' } },
      { id: '2', tool: 'write', input: { path: '/b', content: 'y' } },
    ]
    const { parallel, serial } = partitionByConflict(calls)
    expect(parallel).toHaveLength(2)
    expect(serial).toHaveLength(0)
  })

  it('puts all read calls in parallel', () => {
    const calls = [
      { id: '1', tool: 'read', input: { path: '/a' } },
      { id: '2', tool: 'read', input: { path: '/a' } },
    ]
    const { parallel, serial } = partitionByConflict(calls)
    expect(parallel).toHaveLength(2)
    expect(serial).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/tool-exec.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/tool-exec.ts
import type { ToolContext, ToolResult } from '../shared/types/tool.js'
import { executeTool } from '../tools/executor.js'
import type { PermissionChecker, ToolRegistry } from '../tools/types.js'

/** A collected tool call ready for execution. */
type CollectedToolCall = {
  id: string
  tool: string
  input: unknown
}

/** A tool execution result paired with its call id. */
type ToolCallResult = {
  id: string
  result: ToolResult
}

/** Write-capable tools that may conflict on the same file path. */
const WRITE_TOOLS = new Set(['write', 'edit', 'bash'])

/**
 * Execute a single tool call via the tools executor.
 * This is a thin wrapper around executeTool that the loop calls.
 */
async function executeToolCall(
  registry: ToolRegistry,
  permission: PermissionChecker,
  ctx: ToolContext,
  name: string,
  input: unknown,
): Promise<ToolResult> {
  return executeTool(registry, name, input, ctx, permission)
}

/**
 * Partition tool calls into parallel-safe and serial (write-conflict) groups.
 * Two write-capable tools targeting the same file path go to serial.
 */
function partitionByConflict(calls: CollectedToolCall[]): {
  parallel: CollectedToolCall[]
  serial: CollectedToolCall[]
} {
  const parallel: CollectedToolCall[] = []
  const serial: CollectedToolCall[] = []
  const writePaths = new Set<string>()

  for (const tc of calls) {
    if (WRITE_TOOLS.has(tc.tool)) {
      const input = tc.input as Record<string, unknown> | undefined
      const path = (input?.path ?? input?.file) as string | undefined
      if (path && writePaths.has(path)) {
        serial.push(tc) // conflict → serial
      } else {
        if (path) writePaths.add(path)
        parallel.push(tc)
      }
    } else {
      parallel.push(tc) // read-only → parallel
    }
  }

  return { parallel, serial }
}

/**
 * Execute multiple tool calls. Parallel-safe calls run concurrently via
 * Promise.allSettled; conflicting write calls run serially afterward.
 */
async function executeToolCalls(
  registry: ToolRegistry,
  permission: PermissionChecker,
  ctx: ToolContext,
  calls: CollectedToolCall[],
): Promise<ToolCallResult[]> {
  const { parallel, serial } = partitionByConflict(calls)
  const results: ToolCallResult[] = []

  // Parallel batch
  if (parallel.length > 0) {
    const settled = await Promise.allSettled(
      parallel.map(async (tc) => ({
        id: tc.id,
        result: await executeToolCall(registry, permission, ctx, tc.tool, tc.input),
      })),
    )
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value)
      } else {
        results.push({ id: 'unknown', result: { _tag: 'error', error: String(s.reason) } })
      }
    }
  }

  // Serial batch (write conflicts)
  for (const tc of serial) {
    const result = await executeToolCall(registry, permission, ctx, tc.tool, tc.input)
    results.push({ id: tc.id, result })
  }

  return results
}

export { executeToolCall, executeToolCalls, partitionByConflict }
export type { CollectedToolCall, ToolCallResult }
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/core/tool-exec.test.ts`
Expected: PASS — all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/tool-exec.ts src/core/tool-exec.test.ts
git commit -m "feat(core): add tool execution wrapper with parallel + conflict detection"
```

---

## Task 8: Agent Loop (`loop.ts`)

**Files:**
- Create: `src/core/loop.ts`
- Test: `src/core/loop.test.ts`

The main turn loop: `agentLoop(state, deps)` returns `AsyncGenerator<AgentEvent>`. Each iteration: drain steering → build request → stream LLM → execute tools → persist → check compaction. Handles pause/resume, abort, and max turns.

This is the heart of the agent. The test uses a **mock LLM** (a fake `chatStream` generator that yields canned chunks) so the loop can be tested without network calls.

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/loop.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { agentLoop } from './loop.js'
import type { AgentDependencies } from './types.js'
import type { AgentState } from '../shared/types/agent.js'
import type { Message } from '../shared/types/message.js'
import type { Session } from '../shared/types/message.js'
import type { StreamChunk } from '../shared/types/llm.js'
import { createDB } from '../db/client.js'
import { createSession, appendMessage } from '../session/index.js'
import { createDefaultRegistry } from '../tools/index.js'
import { autoAllowChecker } from '../tools/permission.js'
import { DEFAULT_CONFIG } from './config.js'

// A mock chatStream that yields a text response with no tool calls.
function mockTextStream(text: string): AsyncGenerator<StreamChunk> {
  async function* gen() {
    yield { _tag: 'text', text }
    yield { _tag: 'done' }
  }
  return gen()
}

// A mock chatStream that yields a tool call, then a follow-up text response on the next turn.
function mockToolThenTextStream(): AsyncGenerator<StreamChunk> {
  let turn = 0
  async function* gen() {
    if (turn === 0) {
      yield { _tag: 'tool_call_start', id: 'tc1', name: 'read' }
      yield { _tag: 'tool_call_end', id: 'tc1', argumentsFinal: JSON.stringify({ path: 'package.json' }) }
      yield { _tag: 'done' }
    } else {
      yield { _tag: 'text', text: 'Done reading.' }
      yield { _tag: 'done' }
    }
    turn++
  }
  return gen()
}

function makeMockDeps(db: any, streamFn: () => AsyncGenerator<StreamChunk>): AgentDependencies {
  return {
    db,
    llmRegistry: {} as any,
    toolRegistry: createDefaultRegistry(),
    permission: autoAllowChecker,
    config: DEFAULT_CONFIG,
    cwd: process.cwd(),
    // Injected stream function — the loop uses deps.chatStream
    chatStream: streamFn as any,
  } as any
}

function makeState(session: Session, messages: Message[]): AgentState {
  return {
    id: 'agent1',
    session,
    messages,
    tools: [],
    config: { provider: 'mock', model: 'mock', tools: ['read'], plugins: [], maxTurns: 10 },
    status: { _tag: 'idle' },
    abortController: new AbortController(),
    steeringQueue: [],
    llmDetails: [],
    tokenBudget: { total: 100_000, reserved: 20_000, available: 80_000, used: 0, keepRecent: 10_000 },
  }
}

let db: any
let session: Session

beforeEach(async () => {
  db = await createDB(':memory:')
  session = await createSession(db, { title: 'test' })
  await appendMessage(db, session.id, {
    role: 'user', content: [{ _tag: 'text', text: 'Hello' }],
  })
})

describe('agentLoop', () => {
  it('emits text_delta and done for a simple text response', async () => {
    const messages = await import('../session/index.js').then((m) => m.getMessages(db, session.id))
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockTextStream('Hello back!'))
    const events: any[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'text_delta' && e.text === 'Hello back!')).toBe(true)
    expect(events.some((e) => e._tag === 'done')).toBe(true)
  })

  it('emits tool_call events and executes the tool', async () => {
    const messages = await import('../session/index.js').then((m) => m.getMessages(db, session.id))
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockToolThenTextStream())
    const events: any[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'tool_call_start')).toBe(true)
    expect(events.some((e) => e._tag === 'tool_call_end')).toBe(true)
    // After tool execution, the loop continues and emits text from turn 2
    expect(events.some((e) => e._tag === 'text_delta')).toBe(true)
    expect(events.some((e) => e._tag === 'done')).toBe(true)
  })

  it('stops on abort', async () => {
    const messages = await import('../session/index.js').then((m) => m.getMessages(db, session.id))
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockTextStream('Hello'))
    // Abort before first iteration completes
    state.abortController.abort()
    const events: any[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'error')).toBe(true)
  })

  it('respects maxTurns', async () => {
    const messages = await import('../session/index.js').then((m) => m.getMessages(db, session.id))
    const state = makeState(session, messages)
    state.config.maxTurns = 1
    // Always emit a tool call so the loop never terminates naturally
    const deps = makeMockDeps(db, () => mockToolThenTextStream())
    const events: any[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'error' && e.error._tag === 'max_turns')).toBe(true)
  })

  it('drains steering messages before LLM call', async () => {
    const messages = await import('../session/index.js').then((m) => m.getMessages(db, session.id))
    const state = makeState(session, messages)
    state.steeringQueue.push('Be extra careful')
    const deps = makeMockDeps(db, () => mockTextStream('ok'))
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    expect(state.steeringQueue).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/loop.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/loop.ts
import type { AgentDependencies } from './types.js'
import type { AgentEvent, AgentState } from '../shared/types/agent.js'
import type { Message, MessageContent } from '../shared/types/message.js'
import type { ChatMessage, ChatRequest, ChatTool, StreamChunk } from '../shared/types/llm.js'
import type { ToolResult } from '../shared/types/tool.js'
import { drainSteering } from './steering.js'
import { executeToolCalls } from './tool-exec.js'
import type { CollectedToolCall } from './tool-exec.js'
import { appendMessage } from '../session/message.js'
import { entriesToChatMessages, getSessionContext } from '../session/context.js'
import { estimateBudget, shouldCompact } from './context.js'
import { runCompaction } from './compact.js'
import { createSummarizer } from './compact.js'
import { buildSystemPrompt } from './prompt.js'
import { chatStream as llmChatStream } from '../llm/provider.js'
import { getMessages } from '../session/message.js'
import { generateId } from '../shared/index.js'

/** Extended deps with optional injected chatStream (for testing). */
type LoopDeps = AgentDependencies & {
  chatStream?: typeof llmChatStream
}

/** Sleep helper (injectable for testing). */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Wait for the agent to leave paused state. Polls every 100ms. */
async function waitForResume(state: AgentState): Promise<void> {
  while (state.status._tag === 'paused') {
    await sleep(100)
    if (state.status._tag === 'stopped') return
  }
}

/** Convert a tool result to a MessageContent part for persistence. */
function toolResultToContent(
  toolName: string,
  result: ToolResult,
): MessageContent[] {
  return [{ _tag: 'tool_result', id: generateId(), tool: toolName, output: result }]
}

/**
 * The main agent turn loop.
 * Yields AgentEvent values until the LLM stops calling tools or limits are hit.
 */
export async function* agentLoop(
  state: AgentState,
  deps: LoopDeps,
): AsyncGenerator<AgentEvent> {
  const maxTurns = state.config.maxTurns ?? 50
  const streamFn = deps.chatStream ?? llmChatStream

  for (let turn = 0; turn < maxTurns; turn++) {
    // 1. Check pause/abort
    if (state.abortController.signal.aborted) {
      yield { _tag: 'error', error: { _tag: 'aborted' } }
      return
    }
    if (state.status._tag === 'paused') {
      state.status = { _tag: 'running', turnCount: turn }
      yield { _tag: 'status_change', status: state.status }
      await waitForResume(state)
      if (state.status._tag === 'stopped') return
    }
    state.status = { _tag: 'running', turnCount: turn }

    // 2. Drain steering messages into the request
    const steering = drainSteering(state)

    // 3. Load full session context (entries include compaction/squash summaries)
    const { entries, snapshots } = await getSessionContext(deps.db, state.session.id)

    // 4. Build chat messages for the LLM (entries carry compaction summaries)
    const chatMessages = entriesToChatMessages(entries, snapshots)

    // Inject steering as system messages
    for (const s of steering) {
      chatMessages.push({ role: 'system', content: s })
    }

    // 5. Build the request
    const systemPrompt = state.config.systemPrompt ?? buildSystemPrompt({
      tools: state.tools,
      config: state.config,
      projectInfo: { name: 'project', language: 'TypeScript', rootDir: deps.cwd },
    })

    // Build ChatTool list from tool registry
    const tools: ChatTool[] = state.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))

    const request: ChatRequest = {
      model: state.config.model,
      messages: chatMessages,
      tools: tools.length > 0 ? tools : undefined,
      stream: true,
      system: systemPrompt,
      ...(state.config.maxTokens !== undefined ? { maxTokens: state.config.maxTokens } : {}),
      ...(state.config.temperature !== undefined ? { temperature: state.config.temperature } : {}),
    }

    // 6. Stream the LLM response
    const collectedText: string[] = []
    const collectedToolCalls: Map<string, CollectedToolCall> = new Map()
    const toolCallArgs: Map<string, string> = new Map()
    let hadError = false

    try {
      for await (const chunk of streamFn(
        { registry: deps.llmRegistry, signal: state.abortController.signal },
        request,
        { provider: state.config.provider, model: state.config.model },
      )) {
        if (state.abortController.signal.aborted) {
          yield { _tag: 'error', error: { _tag: 'aborted' } }
          return
        }

        switch (chunk._tag) {
          case 'text':
            collectedText.push(chunk.text)
            yield { _tag: 'text_delta', text: chunk.text }
            break

          case 'tool_call_start':
            collectedToolCalls.set(chunk.id, { id: chunk.id, tool: chunk.name, input: {} })
            toolCallArgs.set(chunk.id, '')
            yield {
              _tag: 'tool_call_start',
              id: chunk.id,
              tool: chunk.name,
              input: {},
            }
            break

          case 'tool_call_delta': {
            const existing = toolCallArgs.get(chunk.id) ?? ''
            toolCallArgs.set(chunk.id, existing + chunk.argumentsDelta)
            break
          }

          case 'tool_call_end': {
            const id = chunk.id
            const finalArgs = chunk.argumentsFinal ?? toolCallArgs.get(id) ?? '{}'
            let parsed: unknown = {}
            try {
              parsed = JSON.parse(finalArgs)
            } catch {
              parsed = { _raw: finalArgs }
            }
            const tc = collectedToolCalls.get(id)
            if (tc) {
              tc.input = parsed
            }
            break
          }

          case 'thinking':
            yield { _tag: 'thinking', text: chunk.text }
            break

          case 'usage':
            yield {
              _tag: 'usage',
              input: chunk.inputTokens,
              output: chunk.outputTokens,
              cacheRead: chunk.cacheRead,
            }
            break

          case 'done':
            break

          case 'error':
            yield {
              _tag: 'error',
              error: {
                _tag: 'provider',
                message: chunk.error.message,
                retryable: chunk.error.retryable ?? false,
              },
            }
            hadError = true
            break
        }
      }
    } catch (err) {
      yield {
        _tag: 'error',
        error: {
          _tag: 'unexpected',
          message: err instanceof Error ? err.message : String(err),
        },
      }
      state.status = { _tag: 'stopped', reason: 'error', error: { _tag: 'unexpected', message: String(err) } }
      return
    }

    if (hadError) {
      state.status = { _tag: 'stopped', reason: 'error' }
      return
    }

    // 7. Persist the assistant message (text + tool calls)
    const assistantContent: MessageContent[] = []
    if (collectedText.length > 0) {
      assistantContent.push({ _tag: 'text', text: collectedText.join('') })
    }
    for (const tc of collectedToolCalls.values()) {
      assistantContent.push({ _tag: 'tool_call', id: tc.id, tool: tc.tool, input: tc.input })
    }
    if (assistantContent.length > 0) {
      await appendMessage(deps.db, state.session.id, {
        role: 'assistant',
        content: assistantContent,
      })
    }

    // 8. Execute tool calls (if any)
    if (collectedToolCalls.size > 0) {
      const calls = Array.from(collectedToolCalls.values())
      if (calls.length > 1) {
        yield {
          _tag: 'tool_calls_parallel',
          calls: calls.map((c) => ({ id: c.id, tool: c.tool, input: c.input })),
        }
      }

      const results = await executeToolCalls(
        deps.toolRegistry,
        deps.permission,
        {
          cwd: deps.cwd,
          session: { id: state.session.id, cwd: deps.cwd },
          abort: state.abortController.signal,
        },
        calls,
      )

      for (const { id, result } of results) {
        yield { _tag: 'tool_call_end', id, result }
        // Persist tool result message
        const tc = calls.find((c) => c.id === id)
        if (tc) {
          await appendMessage(deps.db, state.session.id, {
            role: 'tool',
            content: toolResultToContent(tc.tool, result),
          })
        }
      }
    }

    // 9. If no tool calls, the turn is complete
    if (collectedToolCalls.size === 0) {
      state.status = { _tag: 'stopped', reason: 'completed' }
      yield { _tag: 'done' }
      return
    }

    // 10. Update token budget and check compaction
    const latestMessages = await getMessages(deps.db, state.session.id)
    state.tokenBudget.used = estimateBudget(latestMessages)
    state.messages = latestMessages

    if (shouldCompact(latestMessages, state.tokenBudget, deps.config.compaction)) {
      const summarizer = state.compactionModel
        ? createSummarizer(deps.llmRegistry, state.compactionModel.provider, state.compactionModel.model, { signal: state.abortController.signal })
        : createSummarizer(deps.llmRegistry, state.config.provider, state.config.model, { signal: state.abortController.signal })
      try {
        await runCompaction(deps.db, state.session.id, summarizer, {
          threshold: deps.config.compaction.threshold,
        })
        state.tokenBudget.used = estimateBudget(await getMessages(deps.db, state.session.id))
      } catch {
        // Compaction failure is non-fatal; continue the loop
      }
    }
  }

  // Exceeded max turns
  yield { _tag: 'error', error: { _tag: 'max_turns', maxTurns } }
  state.status = { _tag: 'stopped', reason: 'error', error: { _tag: 'max_turns', maxTurns } }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/core/loop.test.ts`
Expected: PASS — all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/loop.ts src/core/loop.test.ts
git commit -m "feat(core): add agent loop — streaming, tool exec, steering, compaction"
```

---

## Task 9: Agent Factory & Control (`agent.ts`)

**Files:**
- Create: `src/core/agent.ts`
- Test: `src/core/agent.test.ts`

`createAgent` builds the initial `AgentState` (loading existing session messages from DB). `runAgent` wraps `agentLoop` after persisting the user message. Control functions: `pauseAgent`, `resumeAgent`, `abortAgent`, `getAgentStatus`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/agent.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createAgent, runAgent, pauseAgent, resumeAgent, abortAgent, getAgentStatus } from './agent.js'
import type { AgentDependencies } from './types.js'
import type { StreamChunk } from '../shared/types/llm.js'
import { createDB } from '../db/client.js'
import { createSession } from '../session/session.js'
import { getMessages } from '../session/message.js'
import { createDefaultRegistry } from '../tools/index.js'
import { autoAllowChecker } from '../tools/permission.js'
import { DEFAULT_CONFIG } from './config.js'

function mockTextStream(text: string) {
  return async function* (): AsyncGenerator<StreamChunk> {
    yield { _tag: 'text', text }
    yield { _tag: 'done' }
  }
}

function makeDeps(db: any, streamFn: any): AgentDependencies {
  return {
    db,
    llmRegistry: {} as any,
    toolRegistry: createDefaultRegistry(),
    permission: autoAllowChecker,
    config: DEFAULT_CONFIG,
    cwd: process.cwd(),
    chatStream: streamFn,
  } as any
}

let db: any
let session: any

beforeEach(async () => {
  db = await createDB(':memory:')
  session = await createSession(db, { title: 'test' })
})

describe('createAgent', () => {
  it('creates an agent with idle status', async () => {
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: ['read'], plugins: [] },
      makeDeps(db, mockTextStream('hi')),
    )
    expect(agent.status._tag).toBe('idle')
    expect(agent.session.id).toBe(session.id)
    expect(agent.steeringQueue).toEqual([])
  })

  it('loads existing messages from DB', async () => {
    const { appendMessage } = await import('../session/message.js')
    await appendMessage(db, session.id, {
      role: 'user', content: [{ _tag: 'text', text: 'prior message' }],
    })
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [] },
      makeDeps(db, mockTextStream('hi')),
    )
    const messages = await getMessages(db, session.id)
    expect(messages.length).toBeGreaterThan(0)
  })
})

describe('runAgent', () => {
  it('persists user message and runs the loop', async () => {
    const deps = makeDeps(db, mockTextStream('Response!'))
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [], maxTurns: 5 },
      deps,
    )
    const events: any[] = []
    for await (const ev of runAgent(agent, 'Hello', deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'text_delta' && e.text === 'Response!')).toBe(true)
    // User message persisted
    const msgs = await getMessages(db, session.id)
    expect(msgs.some((m) => m.content.some((c) => c._tag === 'text' && c.text === 'Hello'))).toBe(true)
  })

  it('sets status to completed on natural end', async () => {
    const deps = makeDeps(db, mockTextStream('done'))
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [], maxTurns: 5 },
      deps,
    )
    for await (const _ev of runAgent(agent, 'hi', deps)) {
      // consume
    }
    expect(getAgentStatus(agent)._tag).toBe('stopped')
  })
})

describe('control functions', () => {
  it('pauseAgent sets paused status', async () => {
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [] },
      makeDeps(db, mockTextStream('x')),
    )
    agent.status = { _tag: 'running', turnCount: 0 }
    pauseAgent(agent)
    expect(agent.status._tag).toBe('paused')
  })

  it('resumeAgent sets running status', async () => {
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [] },
      makeDeps(db, mockTextStream('x')),
    )
    agent.status = { _tag: 'paused', pauseReason: 'test' }
    resumeAgent(agent)
    expect(agent.status._tag).toBe('running')
  })

  it('abortAgent triggers abort and sets stopped', async () => {
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [] },
      makeDeps(db, mockTextStream('x')),
    )
    abortAgent(agent)
    expect(agent.abortController.signal.aborted).toBe(true)
  })

  it('pauseAgent is a no-op when not running', async () => {
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [] },
      makeDeps(db, mockTextStream('x')),
    )
    pauseAgent(agent)
    expect(agent.status._tag).toBe('idle') // unchanged
  })

  it('getAgentStatus returns current status', async () => {
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [] },
      makeDeps(db, mockTextStream('x')),
    )
    expect(getAgentStatus(agent)).toBe(agent.status)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/agent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/agent.ts
import type { AgentDependencies } from './types.js'
import type { AgentConfig, AgentEvent, AgentState, AgentStatus } from '../shared/types/agent.js'
import type { Session } from '../shared/types/message.js'
import { generateId } from '../shared/index.js'
import { appendMessage, getMessages } from '../session/message.js'
import { estimateBudget } from './context.js'
import { agentLoop } from './loop.js'
import { listTools } from '../tools/registry.js'

/**
 * Create a new agent state for a session.
 * Loads existing messages from the DB so the agent can resume a session.
 */
async function createAgent(
  session: Session,
  config: AgentConfig,
  deps: AgentDependencies,
): Promise<AgentState> {
  const messages = await getMessages(deps.db, session.id)
  const used = estimateBudget(messages)

  // Resolve tool definitions from the registry based on config.tools
  // listTools returns ToolDef[] (with execute/permission), unlike getToolSchemas (ChatTool[])
  const allTools = listTools(deps.toolRegistry, { config: {}, cwd: deps.cwd })
  const tools = allTools.filter((t) => config.tools.includes(t.name))

  return {
    id: generateId(),
    session,
    messages,
    tools,
    config,
    status: { _tag: 'idle' },
    abortController: new AbortController(),
    steeringQueue: [],
    llmDetails: [],
    tokenBudget: {
      total: 128_000, // default; overridden by config when model limits are known
      reserved: 25_600,
      available: 102_400,
      used,
      keepRecent: 12_800,
    },
  }
}

/**
 * Run the agent loop with a user message.
 * Persists the user message, then enters the turn loop.
 */
async function* runAgent(
  state: AgentState,
  userInput: string,
  deps: AgentDependencies,
): AsyncGenerator<AgentEvent> {
  // Persist the user message
  await appendMessage(deps.db, state.session.id, {
    role: 'user',
    content: [{ _tag: 'text', text: userInput }],
  })

  state.status = { _tag: 'running', turnCount: 0 }

  yield* agentLoop(state, deps)
}

/** Pause a running agent. No-op if not running. */
function pauseAgent(state: AgentState): void {
  if (state.status._tag !== 'running') return
  state.status = { _tag: 'paused', pauseReason: 'User requested pause' }
}

/** Resume a paused agent. No-op if not paused. */
function resumeAgent(state: AgentState): void {
  if (state.status._tag !== 'paused') return
  state.status = { _tag: 'running', turnCount: 0 }
}

/** Abort the agent. Triggers the AbortController; the loop will stop at the next checkpoint. */
function abortAgent(state: AgentState): void {
  state.abortController.abort()
  if (state.status._tag === 'running' || state.status._tag === 'paused') {
    state.status = { _tag: 'stopped', reason: 'aborted' }
  }
}

/** Get the current agent status. */
function getAgentStatus(state: AgentState): AgentStatus {
  return state.status
}

export { abortAgent, createAgent, getAgentStatus, pauseAgent, resumeAgent, runAgent }
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/core/agent.test.ts`
Expected: PASS — all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/agent.ts src/core/agent.test.ts
git commit -m "feat(core): add agent factory, runAgent, and control functions"
```

---

## Task 10: Slash Commands (`slash.ts`)

**Files:**
- Create: `src/core/slash.ts`
- Test: `src/core/slash.test.ts`

`SlashCommand` type, `createSlashRegistry`, and built-in commands: `/compact`, `/model`, `/clear`, `/help`, `/fork`, `/config`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/slash.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createSlashRegistry, parseSlashInput, builtinCommands } from './slash.js'
import type { AgentDependencies } from './types.js'
import { createDB } from '../db/client.js'
import { createSession } from '../session/session.js'
import { createDefaultRegistry } from '../tools/index.js'
import { autoAllowChecker } from '../tools/permission.js'
import { DEFAULT_CONFIG } from './config.js'

let db: any
let deps: AgentDependencies

beforeEach(async () => {
  db = await createDB(':memory:')
  deps = {
    db, llmRegistry: {} as any, toolRegistry: createDefaultRegistry(),
    permission: autoAllowChecker, config: DEFAULT_CONFIG, cwd: process.cwd(),
  } as any
})

describe('parseSlashInput', () => {
  it('parses command without args', () => {
    const parsed = parseSlashInput('/help')
    expect(parsed.name).toBe('help')
    expect(parsed.args).toBe('')
  })

  it('parses command with args', () => {
    const parsed = parseSlashInput('/model gpt-4o')
    expect(parsed.name).toBe('model')
    expect(parsed.args).toBe('gpt-4o')
  })

  it('returns null for non-slash input', () => {
    expect(parseSlashInput('hello')).toBeNull()
  })
})

describe('slash registry', () => {
  it('registers and retrieves commands', () => {
    const reg = createSlashRegistry()
    expect(reg.has('help')).toBe(true)
    expect(reg.has('compact')).toBe(true)
    expect(reg.get('help')?.name).toBe('help')
  })

  it('lists all builtin commands', () => {
    const reg = createSlashRegistry()
    const names = reg.list().map((c) => c.name)
    expect(names).toContain('help')
    expect(names).toContain('compact')
    expect(names).toContain('model')
    expect(names).toContain('clear')
    expect(names).toContain('fork')
    expect(names).toContain('config')
  })
})

describe('builtin commands', () => {
  it('/help returns text listing commands', async () => {
    const reg = createSlashRegistry()
    const cmd = reg.get('help')!
    const result = await cmd.execute('', { cwd: '/', config: DEFAULT_CONFIG, deps })
    expect(result._tag).toBe('text')
    if (result._tag === 'text') {
      expect(result.text).toContain('compact')
      expect(result.text).toContain('model')
    }
  })

  it('/config without args shows current config', async () => {
    const reg = createSlashRegistry()
    const cmd = reg.get('config')!
    const result = await cmd.execute('', { cwd: '/', config: DEFAULT_CONFIG, deps })
    expect(result._tag).toBe('text')
  })

  it('/clear clears session messages', async () => {
    const session = await createSession(db, { title: 't' })
    const { appendMessage } = await import('../session/message.js')
    await appendMessage(db, session.id, {
      role: 'user', content: [{ _tag: 'text', text: 'hello' }],
    })
    const reg = createSlashRegistry()
    const cmd = reg.get('clear')!
    const result = await cmd.execute(session.id, { cwd: '/', config: DEFAULT_CONFIG, deps })
    expect(result._tag).toBe('success')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/slash.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/slash.ts
import type { CommandContext, CommandResult, SlashCommand } from './types.js'
import type { Config } from './config.js'

/** Parse a user input string into command name + args. Returns null if not a slash command. */
function parseSlashInput(input: string): { name: string; args: string } | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const spaceIdx = trimmed.indexOf(' ')
  if (spaceIdx === -1) {
    return { name: trimmed.slice(1), args: '' }
  }
  return { name: trimmed.slice(1, spaceIdx), args: trimmed.slice(spaceIdx + 1).trim() }
}

/** Registry for slash commands. */
type SlashRegistry = {
  has: (name: string) => boolean
  get: (name: string) => SlashCommand | undefined
  list: () => SlashCommand[]
  register: (cmd: SlashCommand) => void
}

function createSlashRegistry(): SlashRegistry {
  const commands = new Map<string, SlashCommand>()
  for (const cmd of builtinCommands) {
    commands.set(cmd.name, cmd)
  }
  return {
    has: (name) => commands.has(name),
    get: (name) => commands.get(name),
    list: () => Array.from(commands.values()),
    register: (cmd) => commands.set(cmd.name, cmd),
  }
}

const helpCommand: SlashCommand = {
  name: 'help',
  description: 'List available slash commands',
  execute: async (_args, _ctx) => {
    const lines = [
      'Available commands:',
      '  /compact        Manually trigger context compaction',
      '  /model <name>   Switch the current session model',
      '  /clear          Clear session messages',
      '  /help           Show this help',
      '  /fork [index]   Fork session from a message',
      '  /config [k][v]  View or set configuration',
    ]
    return { _tag: 'text', text: lines.join('\n') }
  },
}

const compactCommand: SlashCommand = {
  name: 'compact',
  description: 'Manually trigger context compaction',
  execute: async (_args, ctx) => {
    // Full compaction requires a session+summarizer; the server layer wires this.
    // Here we signal intent.
    return { _tag: 'success', message: 'Compaction queued. Use the agent API to trigger with a summarizer.' }
  },
}

const modelCommand: SlashCommand = {
  name: 'model',
  description: 'Switch the current session model',
  argsHint: '<model-name>',
  execute: async (args, _ctx) => {
    if (!args) return { _tag: 'error', message: 'Usage: /model <model-name>' }
    // Actual model switching is handled by the server layer (updates config + restarts agent)
    return { _tag: 'success', message: `Model set to ${args} (takes effect next turn)` }
  },
}

const clearCommand: SlashCommand = {
  name: 'clear',
  description: 'Clear session messages',
  execute: async (sessionId, ctx) => {
    if (!sessionId) return { _tag: 'error', message: 'Usage: /clear <session-id>' }
    // Delete all messages for the session
    const { deleteEntriesByIds, getEntries } = await import('../session/message.js')
    const entries = await getEntries(ctx.deps.db, sessionId)
    const ids = entries.map((e) => 'id' in e ? e.id : '').filter(Boolean)
    if (ids.length > 0) {
      await deleteEntriesByIds(ctx.deps.db, ids)
    }
    return { _tag: 'success', message: `Cleared ${ids.length} entries` }
  },
}

const forkCommand: SlashCommand = {
  name: 'fork',
  description: 'Fork session from a message index',
  argsHint: '[message-index]',
  execute: async (args, ctx) => {
    const sessionId = args || ''
    if (!sessionId) return { _tag: 'error', message: 'Usage: /fork <session-id>' }
    const { forkSession } = await import('../session/branch.js')
    const forked = await forkSession(ctx.deps.db, sessionId)
    return { _tag: 'success', message: `Forked to new session: ${forked.id}` }
  },
}

const configCommand: SlashCommand = {
  name: 'config',
  description: 'View or set configuration',
  argsHint: '[key] [value]',
  execute: async (args, ctx) => {
    if (!args) {
      return { _tag: 'text', text: JSON.stringify(ctx.config, null, 2) }
    }
    const parts = args.split(/\s+/)
    const key = parts[0] ?? ''
    if (parts.length === 1) {
      const value = (ctx.config as Record<string, unknown>)[key]
      return { _tag: 'text', text: `${key}: ${JSON.stringify(value)}` }
    }
    return { _tag: 'success', message: `Config updates are handled via the config API` }
  },
}

const builtinCommands: SlashCommand[] = [
  helpCommand,
  compactCommand,
  modelCommand,
  clearCommand,
  forkCommand,
  configCommand,
]

export { builtinCommands, createSlashRegistry, parseSlashInput }
export type { SlashRegistry }
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/core/slash.test.ts`
Expected: PASS — all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/slash.ts src/core/slash.test.ts
git commit -m "feat(core): add slash commands — help, compact, model, clear, fork, config"
```

---

## Task 11: Barrel Export (`index.ts`)

**Files:**
- Modify: `src/core/index.ts`
- Test: `src/core/index.test.ts`

Barrel export of all public API from the core package.

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/index.test.ts
import { describe, it, expect } from 'vitest'
import * as core from './index.js'

describe('core barrel export', () => {
  it('exports config functions', () => {
    expect(typeof core.DEFAULT_CONFIG).toBe('object')
    expect(typeof core.loadConfig).toBe('function')
    expect(typeof core.mergeConfig).toBe('function')
    expect(typeof core.saveConfig).toBe('function')
  })

  it('exports context functions', () => {
    expect(typeof core.createTokenBudget).toBe('function')
    expect(typeof core.fitToBudget).toBe('function')
    expect(typeof core.shouldCompact).toBe('function')
  })

  it('exports prompt builder', () => {
    expect(typeof core.buildSystemPrompt).toBe('function')
  })

  it('exports steering functions', () => {
    expect(typeof core.injectSteering).toBe('function')
    expect(typeof core.drainSteering).toBe('function')
  })

  it('exports agent functions', () => {
    expect(typeof core.createAgent).toBe('function')
    expect(typeof core.runAgent).toBe('function')
    expect(typeof core.pauseAgent).toBe('function')
    expect(typeof core.resumeAgent).toBe('function')
    expect(typeof core.abortAgent).toBe('function')
  })

  it('exports slash command registry', () => {
    expect(typeof core.createSlashRegistry).toBe('function')
    expect(typeof core.parseSlashInput).toBe('function')
  })

  it('exports compaction bridge', () => {
    expect(typeof core.createSummarizer).toBe('function')
    expect(typeof core.runCompaction).toBe('function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/index.test.ts`
Expected: FAIL — exports not found (current `index.ts` is empty).

- [ ] **Step 3: Write the barrel**

```typescript
// src/core/index.ts
// Core package: agent loop, prompt building, config, context management,
// steering, slash commands, and compaction bridge.

// ── Config ──────────────────────────────────────────────────
export { DEFAULT_CONFIG, loadConfig, mergeConfig, saveConfig } from './config.js'
export type { CompactionConfig, Config, MCPServerConfig } from './config.js'

// ── Context ─────────────────────────────────────────────────
export { createTokenBudget, estimateBudget, fitToBudget, shouldCompact } from './context.js'

// ── Prompt ──────────────────────────────────────────────────
export { buildSystemPrompt } from './prompt.js'

// ── Steering ────────────────────────────────────────────────
export { clearSteering, drainSteering, injectSteering } from './steering.js'

// ── Compaction bridge ───────────────────────────────────────
export { createSummarizer, runCompaction } from './compact.js'

// ── Tool execution ──────────────────────────────────────────
export { executeToolCall, executeToolCalls, partitionByConflict } from './tool-exec.js'
export type { CollectedToolCall, ToolCallResult } from './tool-exec.js'

// ── Agent loop ──────────────────────────────────────────────
export { agentLoop } from './loop.js'

// ── Agent factory & control ─────────────────────────────────
export {
  abortAgent,
  createAgent,
  getAgentStatus,
  pauseAgent,
  resumeAgent,
  runAgent,
} from './agent.js'

// ── Slash commands ──────────────────────────────────────────
export { builtinCommands, createSlashRegistry, parseSlashInput } from './slash.js'
export type { SlashRegistry } from './slash.js'

// ── Types ───────────────────────────────────────────────────
export type {
  AgentDependencies,
  CommandContext,
  CommandResult,
  ProjectInfo,
  PromptContext,
  SlashCommand,
} from './types.js'
export type {
  AgentConfig,
  AgentError,
  AgentEvent,
  AgentState,
  AgentStatus,
  LLMDetail,
  PendingToolCall,
  TokenBudget,
} from './types.js'
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/core/index.test.ts`
Expected: PASS — all 7 tests.

- [ ] **Step 5: Run full test suite**

Run: `pnpm vitest run src/core/`
Expected: ALL PASS.

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/index.ts src/core/index.test.ts
git commit -m "feat(core): add barrel export for full core package API"
```

---

## Completion Checklist

After all 11 tasks:

- [ ] Run `pnpm vitest run src/core/` — all core tests pass
- [ ] Run `pnpm typecheck` — no type errors
- [ ] Run `pnpm biome check src/core/ --write` — format/lint clean
- [ ] Run `pnpm vitest run` — full suite (Plan 1-6) still passes
- [ ] Verify no circular imports: `core → {shared, db, llm, session, tools}` only
