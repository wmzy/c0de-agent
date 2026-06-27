# LLM Provider Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the LLM provider abstraction — schema types, an OpenAI-compatible protocol with SSE streaming, provider registry with role routing and fallback, retry policy, context-overflow detection, and a public `chatStream`/`chat` API that maps the shared `ChatRequest`/`StreamChunk` types.

**Architecture:** Translates opencode's three-layer (Protocol → Route → Transport) design into c0de-agent's pure data+functions paradigm: `Effect<T,E>` → `Promise<T>` throwing a plain-object `LLMError`; `Stream<T,E>` → `AsyncGenerator<T>`; `class`-branded types → branded `type` + factory functions; `Context.Service` DI → explicit context-first arguments. The package exposes a stable contract (`chatStream(ctx, ChatRequest): AsyncGenerator<StreamChunk>`) that Plans 4-6 consume, while internally carrying the richer `InternalRequest`/`StreamEvent` fidelity from the spec. Only the OpenAI-compatible protocol is implemented (covers OpenAI, DeepSeek, Groq, Together, OpenRouter, etc.); Anthropic/Gemini/Bedrock protocols, cache-breakpoint policy, and WebSocket transport are deferred to later plans.

**Tech Stack:** TypeScript 5.7+ (ESM, NodeNext, strict, `verbatimModuleSyntax`), `fetch` (Node 22 global), Vitest 3.x, Biome 2.x. No new runtime dependencies — streaming uses the global `fetch` + `ReadableStream`.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/llm/schema/ids.ts` | Branded ID types, `FinishReason`, `JsonSchema`, `ProviderMetadata`, brand factories |
| `src/llm/schema/options.ts` | `HttpOptions`, `GenerationOptions`, `ModelLimits`, `Model` + factory, `CacheHint`/`CachePolicy`, `ProviderOptions`, merge utils |
| `src/llm/schema/messages.ts` | `SystemPart`, `TextPart`/`ReasoningPart`/`ToolCallPart`/`ToolResultPart`, `ContentPart`, `Message` + factories, `ToolDefinition`, `ToolChoice`, `ResponseFormat`, `InternalRequest` |
| `src/llm/schema/events.ts` | `Usage` + `usageFrom`, 16-tag `StreamEvent` union, `LLMResponse`, `PreparedRequest` |
| `src/llm/schema/errors.ts` | `HttpContext`, 10-tag `LLMErrorReason`, `LLMError` factory + `isLLMError`, `ToolFailure`, `reasonRetryable` |
| `src/llm/schema/index.ts` | Barrel re-export of all schema types |
| `src/llm/provider-error.ts` | `isContextOverflow` (19 regexes + status fallback), `isContextOverflowFailure` |
| `src/llm/retry.ts` | `RETRY_*` constants, `delay()`, `retryable()`, `withRetry()` wrapper |
| `src/llm/token.ts` | `estimateTokens()` heuristic |
| `src/llm/transport.ts` | `sseFraming()` (ReadableStream → AsyncGenerator<string>), `streamHTTP()` (fetch POST → SSE frames), `classifyHttpError()` |
| `src/llm/protocols/utils/tool-stream.ts` | Tool-call argument accumulator: `empty`/`appendOrStart`/`finishAll` |
| `src/llm/protocols/utils/lifecycle.ts` | Content-block lifecycle state: `initial`/`stepStart`/`textDelta`/`reasoningDelta`/`finish` |
| `src/llm/protocols/utils/index.ts` | Barrel |
| `src/llm/protocols/openai-compat.ts` | `OpenAICompatProtocol` + `OpenAICompatRoute` factory — body builder, SSE event parser, stream step |
| `src/llm/registry.ts` | Provider/route registry, model capability DB, `resolveRoute()`, built-in model catalog |
| `src/llm/routing.ts` | `FallbackChain`, `resolveModelByRole()`, `chatStreamWithFallback()` orchestration |
| `src/llm/provider.ts` | Public `chatStream()`/`chatGenerate()` — bridges shared `ChatRequest`/`StreamChunk` ↔ internal types |
| `src/llm/index.ts` | Public API barrel |

**Dependency chain (no cycles):**

```
schema/ids      → (none)
schema/options  → ids
schema/messages → ids, options
schema/events   → ids, options, messages
schema/errors   → ids
provider-error  → schema/errors, schema/events
retry           → schema/errors
token           → (none)
transport       → schema/errors, provider-error
protocols/utils → schema/events, schema/errors, schema/messages
protocols/openai-compat → schema/*, protocols/utils, transport
registry        → schema/ids, schema/options, openai-compat
routing         → registry, retry, schema/*
provider        → registry, routing, transport, openai-compat, schema/*, shared/types/llm
```

**Design conventions (apply to every task):**
- ESM imports use `.js` extensions; all type-only imports use `import type`.
- `type` not `interface`; no classes — use factory functions returning plain objects.
- `_tag` discriminated unions for all variants; brand opaque IDs via `type Brand<T,B> = T & { readonly _brand?: B }`.
- Errors are thrown plain objects with `_tag: 'LLMError'`; checked via `isLLMError(e)`.
- Context-first argument style: `fn(ctx, ...args)`.
- Run `pnpm typecheck` after each source file; `pnpm test <file>` for each test; `pnpm biome check --write src/` before commits if formatting drifts.

---

### Task 1: Schema — IDs & Options

**Files:**
- Create: `src/llm/schema/ids.ts`
- Create: `src/llm/schema/ids.test.ts`
- Create: `src/llm/schema/options.ts`
- Create: `src/llm/schema/options.test.ts`

- [ ] **Step 1: Write `src/llm/schema/ids.ts`**

```typescript
/** Opaque-brand helper: a value of type T carrying a phantom brand B. */
type Brand<T, B> = T & { readonly _brand?: B }

type ProtocolID = string
type RouteID = string
type ModelID = Brand<string, 'ModelID'>
type ProviderID = Brand<string, 'ProviderID'>
type ResponseID = string
type ContentBlockID = string
type ToolCallID = string

type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type TextVerbosity = 'low' | 'medium' | 'high'
type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'unknown'

/** Loose JSON schema (provider passthrough; not validated structurally here). */
type JsonSchema = Record<string, unknown>

/** Per-provider raw payload passthrough, keyed by provider id. */
type ProviderMetadata = Record<string, Record<string, unknown>>

const modelId = (value: string): ModelID => value as ModelID
const providerId = (value: string): ProviderID => value as ProviderID

export type {
  Brand,
  ContentBlockID,
  FinishReason,
  JsonSchema,
  ModelID,
  ProtocolID,
  ProviderID,
  ProviderMetadata,
  ReasoningEffort,
  ResponseID,
  RouteID,
  TextVerbosity,
  ToolCallID,
}
export { modelId, providerId }
```

- [ ] **Step 2: Write `src/llm/schema/ids.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import { modelId, providerId } from './ids.js'
import type { ModelID, ProviderID } from './ids.js'

describe('schema/ids', () => {
  it('brands a string as ModelID', () => {
    const id: ModelID = modelId('gpt-4o')
    expect(id).toBe('gpt-4o')
  })

  it('brands a string as ProviderID', () => {
    const id: ProviderID = providerId('openai')
    expect(id).toBe('openai')
  })

  it('treats branded ids as assignable to string', () => {
    const id: ModelID = modelId('deepseek-chat')
    const s: string = id
    expect(s).toBe('deepseek-chat')
  })
})
```

- [ ] **Step 3: Run test + typecheck**

Run: `pnpm test src/llm/schema/ids.test.ts`
Expected: PASS — 3 tests.
Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Write `src/llm/schema/options.ts`**

```typescript
import type { JsonSchema, ModelID, ProviderID } from './ids.js'
import { modelId, providerId } from './ids.js'

type HttpOptions = {
  body?: JsonSchema
  headers?: Record<string, string>
  query?: Record<string, string>
}

type GenerationOptions = {
  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  frequencyPenalty?: number
  presencePenalty?: number
  seed?: number
  stop?: string[]
}

type ModelLimits = {
  context?: number
  output?: number
}

type Model = {
  readonly id: ModelID
  readonly provider: ProviderID
  readonly limits?: ModelLimits
}

const model = (id: string, provider: string, limits?: ModelLimits): Model => ({
  id: modelId(id),
  provider: providerId(provider),
  limits,
})

/** Immutable patch of a Model. */
const modelUpdate = (m: Model, patch: Partial<ModelLimits>): Model => ({
  ...m,
  limits: { ...m.limits, ...patch },
})

type CacheHint = {
  type: 'ephemeral' | 'persistent'
  ttlSeconds?: number
}

type CachePolicyObject = {
  tools?: boolean
  system?: boolean
  messages?: 'latest-user-message' | 'latest-assistant' | { tail: number }
  ttlSeconds?: number
}

type CachePolicy = 'auto' | 'none' | CachePolicyObject

type ProviderOptions = Record<string, Record<string, unknown>>

type RouteDefaults = {
  headers?: Record<string, string>
  limits?: ModelLimits
  generation?: GenerationOptions
  providerOptions?: ProviderOptions
  http?: HttpOptions
}

const mergeGenerationOptions = (
  ...opts: (GenerationOptions | undefined)[]
): GenerationOptions | undefined => {
  const filtered = opts.filter((o): o is GenerationOptions => o !== undefined)
  if (filtered.length === 0) return undefined
  return filtered.reduce((acc, o) => ({ ...acc, ...o }), {})
}

const mergeHttpOptions = (...opts: (HttpOptions | undefined)[]): HttpOptions | undefined => {
  const filtered = opts.filter((o): o is HttpOptions => o !== undefined)
  if (filtered.length === 0) return undefined
  return filtered.reduce<HttpOptions>(
    (acc, o) => ({
      ...acc,
      ...o,
      headers: { ...acc.headers, ...o.headers },
      query: { ...acc.query, ...o.query },
    }),
    {},
  )
}

const mergeProviderOptions = (
  ...opts: (ProviderOptions | undefined)[]
): ProviderOptions | undefined => {
  const filtered = opts.filter((o): o is ProviderOptions => o !== undefined)
  if (filtered.length === 0) return undefined
  return filtered.reduce<ProviderOptions>((acc, o) => {
    const merged: ProviderOptions = { ...acc }
    for (const key of Object.keys(o)) {
      merged[key] = { ...(acc[key] ?? {}), ...o[key] }
    }
    return merged
  }, {})
}

export type {
  CacheHint,
  CachePolicy,
  CachePolicyObject,
  GenerationOptions,
  HttpOptions,
  Model,
  ModelLimits,
  ProviderOptions,
  RouteDefaults,
}
export {
  mergeGenerationOptions,
  mergeHttpOptions,
  mergeProviderOptions,
  model,
  modelUpdate,
}
```

- [ ] **Step 5: Write `src/llm/schema/options.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import {
  mergeGenerationOptions,
  mergeHttpOptions,
  mergeProviderOptions,
  model,
  modelUpdate,
} from './options.js'

describe('schema/options Model', () => {
  it('builds a model with branded ids', () => {
    const m = model('gpt-4o', 'openai', { context: 128000, output: 16384 })
    expect(m.id).toBe('gpt-4o')
    expect(m.provider).toBe('openai')
    expect(m.limits?.context).toBe(128000)
  })

  it('patches model limits immutably', () => {
    const m = model('gpt-4o', 'openai', { context: 128000 })
    const m2 = modelUpdate(m, { output: 4096 })
    expect(m2.limits).toEqual({ context: 128000, output: 4096 })
    expect(m.limits?.output).toBeUndefined()
  })
})

describe('schema/options merge', () => {
  it('merges generation options with later winning', () => {
    const merged = mergeGenerationOptions({ temperature: 0.5 }, { temperature: 0.9, topP: 1 })
    expect(merged).toEqual({ temperature: 0.9, topP: 1 })
  })

  it('returns undefined when all undefined', () => {
    expect(mergeGenerationOptions(undefined, undefined)).toBeUndefined()
  })

  it('merges http headers without losing keys', () => {
    const merged = mergeHttpOptions({ headers: { a: '1', b: '2' } }, { headers: { b: '3' } })
    expect(merged?.headers).toEqual({ a: '1', b: '3' })
  })

  it('deep-merges provider options per provider key', () => {
    const merged = mergeProviderOptions(
      { openai: { x: '1' } },
      { openai: { y: '2' }, deepseek: { z: '3' } },
    )
    expect(merged).toEqual({ openai: { x: '1', y: '2' }, deepseek: { z: '3' } })
  })
})
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm test src/llm/schema/options.test.ts`
Expected: PASS — 7 tests.
Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/llm/schema/ids.ts src/llm/schema/ids.test.ts src/llm/schema/options.ts src/llm/schema/options.test.ts
git commit -m "feat(llm): add schema ids (branded types) and options (model, generation, cache)"
```

---

### Task 2: Schema — Messages & InternalRequest

**Files:**
- Create: `src/llm/schema/messages.ts`
- Create: `src/llm/schema/messages.test.ts`

- [ ] **Step 1: Write `src/llm/schema/messages.ts`**

```typescript
import type {
  CacheHint,
  GenerationOptions,
  HttpOptions,
  Model,
  ProviderOptions,
} from './options.js'
import type {
  JsonSchema,
  ModelID,
  ProviderMetadata,
  ToolCallID,
} from './ids.js'

type SystemPart = {
  type: 'text'
  text: string
  cache?: CacheHint
  metadata?: Record<string, unknown>
}

type TextPart = {
  type: 'text'
  text: string
  cache?: CacheHint
  providerMetadata?: ProviderMetadata
}

type ReasoningPart = {
  type: 'reasoning'
  text: string
  encrypted?: string
  providerMetadata?: ProviderMetadata
}

type ToolCallPart = {
  type: 'tool-call'
  id: ToolCallID
  name: string
  input: unknown
  providerExecuted?: boolean
  providerMetadata?: ProviderMetadata
}

type ToolResultValue =
  | { type: 'json'; value: unknown }
  | { type: 'text'; value: unknown }
  | { type: 'error'; value: unknown }

type ToolResultPart = {
  type: 'tool-result'
  id: ToolCallID
  name: string
  result: ToolResultValue
  providerExecuted?: boolean
  cache?: CacheHint
  providerMetadata?: ProviderMetadata
}

type ContentPart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart

type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

type Message = {
  id?: string
  role: MessageRole
  content: ContentPart[]
  metadata?: Record<string, unknown>
}

const messageUser = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
})

const messageAssistant = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
})

const messageSystem = (text: string): Message => ({
  role: 'system',
  content: [{ type: 'text', text }],
})

type ToolDefinition = {
  name: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  cache?: CacheHint
}

type ToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'required' }
  | { type: 'tool'; name: string }

type ResponseFormat =
  | { type: 'text' }
  | { type: 'json'; schema: JsonSchema }

type InternalRequest = {
  id?: string
  model: Model
  system: SystemPart[]
  messages: Message[]
  tools: ToolDefinition[]
  toolChoice?: ToolChoice
  generation?: GenerationOptions
  providerOptions?: ProviderOptions
  http?: HttpOptions
  responseFormat?: ResponseFormat
}

/** Immutable patch of an InternalRequest. */
const requestUpdate = (
  req: InternalRequest,
  patch: Partial<InternalRequest>,
): InternalRequest => ({ ...req, ...patch })

export type {
  ContentPart,
  InternalRequest,
  Message,
  MessageRole,
  ReasoningPart,
  ResponseFormat,
  SystemPart,
  TextPart,
  ToolCallPart,
  ToolChoice,
  ToolDefinition,
  ToolResultPart,
  ToolResultValue,
}
export { messageAssistant, messageSystem, messageUser, requestUpdate }
```

- [ ] **Step 2: Write `src/llm/schema/messages.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import {
  messageAssistant,
  messageSystem,
  messageUser,
  requestUpdate,
} from './messages.js'
import { model } from './options.js'
import type { InternalRequest, Message, ToolDefinition } from './messages.js'

describe('schema/messages factories', () => {
  it('messageUser wraps a string in a text part', () => {
    const m: Message = messageUser('hello')
    expect(m.role).toBe('user')
    expect(m.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('messageAssistant builds an assistant message', () => {
    expect(messageAssistant('ok').role).toBe('assistant')
  })

  it('messageSystem builds a system message', () => {
    expect(messageSystem('be nice').role).toBe('system')
  })
})

describe('schema/messages requestUpdate', () => {
  it('patches an InternalRequest immutably', () => {
    const tools: ToolDefinition[] = [
      { name: 'echo', description: 'd', inputSchema: { type: 'object' } },
    ]
    const req: InternalRequest = {
      model: model('gpt-4o', 'openai'),
      system: [{ type: 'text', text: 'sys' }],
      messages: [messageUser('hi')],
      tools,
    }
    const updated = requestUpdate(req, {
      generation: { temperature: 0.7 },
    })
    expect(updated.generation?.temperature).toBe(0.7)
    expect(req.generation).toBeUndefined()
    expect(updated.tools).toBe(tools)
  })
})
```

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm test src/llm/schema/messages.test.ts`
Expected: PASS — 4 tests.
Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/llm/schema/messages.ts src/llm/schema/messages.test.ts
git commit -m "feat(llm): add schema messages (Message parts, ToolDefinition, InternalRequest)"
```

---

### Task 3: Schema — Events, Usage & LLMResponse

**Files:**
- Create: `src/llm/schema/events.ts`
- Create: `src/llm/schema/events.test.ts`

- [ ] **Step 1: Write `src/llm/schema/events.ts`**

```typescript
import type {
  ContentBlockID,
  FinishReason,
  ProtocolID,
  ProviderMetadata,
  ResponseID,
  RouteID,
  ToolCallID,
} from './ids.js'
import type { Model } from './options.js'
import type { ToolResultValue } from './messages.js'

type Usage = {
  inputTokens?: number
  outputTokens?: number
  nonCachedInputTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  providerMetadata?: ProviderMetadata
}

type UsageInput = Partial<Usage>

const usageFrom = (input: UsageInput): Usage => {
  const inputTokens = input.inputTokens
  const outputTokens = input.outputTokens
  const total =
    input.totalTokens ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined)
  return { ...input, totalTokens: total }
}

/** Visible (non-reasoning) output tokens: max(0, output - reasoning). */
const visibleOutputTokens = (u: Usage): number => {
  const out = u.outputTokens ?? 0
  const reasoning = u.reasoningTokens ?? 0
  return Math.max(0, out - reasoning)
}

type StepStart = { type: 'step-start'; index: number }
type TextStart = { type: 'text-start'; id: ContentBlockID; providerMetadata?: ProviderMetadata }
type TextDelta = { type: 'text-delta'; id: ContentBlockID; text: string; providerMetadata?: ProviderMetadata }
type TextEnd = { type: 'text-end'; id: ContentBlockID; providerMetadata?: ProviderMetadata }
type ReasoningStart = { type: 'reasoning-start'; id: ContentBlockID; providerMetadata?: ProviderMetadata }
type ReasoningDelta = {
  type: 'reasoning-delta'
  id: ContentBlockID
  text: string
  providerMetadata?: ProviderMetadata
}
type ReasoningEnd = { type: 'reasoning-end'; id: ContentBlockID; providerMetadata?: ProviderMetadata }
type ToolInputStart = {
  type: 'tool-input-start'
  id: ToolCallID
  name: string
  providerMetadata?: ProviderMetadata
}
type ToolInputDelta = {
  type: 'tool-input-delta'
  id: ToolCallID
  name: string
  text: string
  providerMetadata?: ProviderMetadata
}
type ToolInputEnd = {
  type: 'tool-input-end'
  id: ToolCallID
  name: string
  providerMetadata?: ProviderMetadata
}
type ToolCallEvent = {
  type: 'tool-call'
  id: ToolCallID
  name: string
  input: unknown
  providerExecuted?: boolean
  providerMetadata?: ProviderMetadata
}
type ToolResultEvent = {
  type: 'tool-result'
  id: ToolCallID
  name: string
  result: ToolResultValue
  providerExecuted?: boolean
  providerMetadata?: ProviderMetadata
}
type ToolErrorEvent = {
  type: 'tool-error'
  id: ToolCallID
  name: string
  message: string
  providerMetadata?: ProviderMetadata
}
type StepFinish = {
  type: 'step-finish'
  index: number
  reason: FinishReason
  usage?: Usage
  providerMetadata?: ProviderMetadata
}
type FinishEvent = {
  type: 'finish'
  reason: FinishReason
  usage?: Usage
  providerMetadata?: ProviderMetadata
  responseId?: ResponseID
}
type ProviderErrorEvent = {
  type: 'provider-error'
  message: string
  classification?: 'context-overflow'
  retryable?: boolean
  providerMetadata?: ProviderMetadata
}

type StreamEvent =
  | StepStart
  | TextStart
  | TextDelta
  | TextEnd
  | ReasoningStart
  | ReasoningDelta
  | ReasoningEnd
  | ToolInputStart
  | ToolInputDelta
  | ToolInputEnd
  | ToolCallEvent
  | ToolResultEvent
  | ToolErrorEvent
  | StepFinish
  | FinishEvent
  | ProviderErrorEvent

type PreparedRequest = {
  id: string
  route: RouteID
  protocol: ProtocolID
  model: Model
  body: unknown
}

type LLMResponse = {
  events: StreamEvent[]
  usage?: Usage
}

/** Fold a list of events into an LLMResponse (used by non-streaming chat). */
const foldResponse = (events: StreamEvent[]): LLMResponse => {
  let usage: Usage | undefined
  for (const event of events) {
    if (
      (event.type === 'finish' || event.type === 'step-finish') &&
      event.usage !== undefined
    ) {
      usage = event.usage
    }
  }
  return { events, usage }
}

const responseText = (res: LLMResponse): string =>
  res.events
    .filter((e): e is TextDelta => e.type === 'text-delta')
    .map((e) => e.text)
    .join('')

const responseReasoning = (res: LLMResponse): string =>
  res.events
    .filter((e): e is ReasoningDelta => e.type === 'reasoning-delta')
    .map((e) => e.text)
    .join('')

const responseToolCalls = (res: LLMResponse): ToolCallEvent[] =>
  res.events.filter((e): e is ToolCallEvent => e.type === 'tool-call')

export type {
  FinishEvent,
  LLMResponse,
  PreparedRequest,
  ProviderErrorEvent,
  ReasoningDelta,
  ReasoningEnd,
  ReasoningStart,
  StepFinish,
  StepStart,
  StreamEvent,
  TextDelta,
  TextEnd,
  TextStart,
  ToolCallEvent,
  ToolErrorEvent,
  ToolInputDelta,
  ToolInputEnd,
  ToolInputStart,
  ToolResultEvent,
  Usage,
  UsageInput,
}
export {
  foldResponse,
  responseReasoning,
  responseText,
  responseToolCalls,
  usageFrom,
  visibleOutputTokens,
}
```

- [ ] **Step 2: Write `src/llm/schema/events.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import {
  foldResponse,
  responseReasoning,
  responseText,
  responseToolCalls,
  usageFrom,
  visibleOutputTokens,
} from './events.js'
import type { StreamEvent, TextDelta, ToolCallEvent } from './events.js'

describe('schema/events Usage', () => {
  it('falls back to input+output for totalTokens', () => {
    const u = usageFrom({ inputTokens: 100, outputTokens: 50 })
    expect(u.totalTokens).toBe(150)
  })

  it('keeps provider-reported total when present', () => {
    const u = usageFrom({ inputTokens: 10, outputTokens: 5, totalTokens: 999 })
    expect(u.totalTokens).toBe(999)
  })

  it('visibleOutputTokens subtracts reasoning from output', () => {
    expect(visibleOutputTokens(usageFrom({ outputTokens: 100, reasoningTokens: 30 }))).toBe(70)
  })

  it('visibleOutputTokens never goes negative', () => {
    expect(visibleOutputTokens(usageFrom({ outputTokens: 10, reasoningTokens: 99 }))).toBe(0)
  })
})

describe('schema/events foldResponse', () => {
  it('folds text deltas into LLMResponse', () => {
    const events: StreamEvent[] = [
      { type: 'text-delta', id: 'b1', text: 'hel' },
      { type: 'text-delta', id: 'b1', text: 'lo' },
      { type: 'finish', reason: 'stop', usage: usageFrom({ inputTokens: 1, outputTokens: 2 }) },
    ]
    const res = foldResponse(events)
    expect(responseText(res)).toBe('hello')
    expect(res.usage?.totalTokens).toBe(3)
  })

  it('collects tool-call events', () => {
    const tc: ToolCallEvent = { type: 'tool-call', id: 't1', name: 'echo', input: { x: 1 } }
    const res = foldResponse([tc])
    expect(responseToolCalls(res)).toEqual([tc])
  })

  it('folds reasoning deltas', () => {
    const events: StreamEvent[] = [
      { type: 'reasoning-delta', id: 'r1', text: 'think' },
      { type: 'reasoning-delta', id: 'r1', text: 'ing' },
    ]
    expect(responseReasoning(foldResponse(events))).toBe('thinking')
  })
})
```

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm test src/llm/schema/events.test.ts`
Expected: PASS — 7 tests.
Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/llm/schema/events.ts src/llm/schema/events.test.ts
git commit -m "feat(llm): add schema events (Usage, 16-tag StreamEvent, LLMResponse)"
```

---

### Task 4: Schema — Errors, LLMError & ToolFailure

**Files:**
- Create: `src/llm/schema/errors.ts`
- Create: `src/llm/schema/errors.test.ts`

- [ ] **Step 1: Write `src/llm/schema/errors.ts`**

```typescript
import type { ProviderMetadata } from './ids.js'

type HttpContext = {
  request: { method: string; url: string; headers: Record<string, string> }
  response?: { status: number; headers: Record<string, string> }
  body?: string
  requestId?: string
}

type LLMErrorReason =
  | {
      _tag: 'InvalidRequest'
      message: string
      parameter?: string
      classification?: 'context-overflow'
      http?: HttpContext
    }
  | { _tag: 'NoRoute'; route: string; provider: string; model: string }
  | {
      _tag: 'Authentication'
      message: string
      kind: 'missing' | 'invalid' | 'expired' | 'insufficient-permissions' | 'unknown'
      http?: HttpContext
    }
  | {
      _tag: 'RateLimit'
      message: string
      retryAfterMs?: number
      http?: HttpContext
    }
  | { _tag: 'QuotaExceeded'; message: string; http?: HttpContext }
  | { _tag: 'ContentPolicy'; message: string; http?: HttpContext }
  | {
      _tag: 'ProviderInternal'
      message: string
      status: number
      retryAfterMs?: number
      http?: HttpContext
    }
  | { _tag: 'Transport'; message: string; kind?: string; url?: string; http?: HttpContext }
  | { _tag: 'InvalidProviderOutput'; message: string; raw?: string }
  | { _tag: 'UnknownProvider'; message: string; status?: number; http?: HttpContext }

/** Human-readable message extracted from any reason. */
const reasonMessage = (reason: LLMErrorReason): string => {
  switch (reason._tag) {
    case 'NoRoute':
      return `No LLM route for model "${reason.model}" using provider "${reason.provider}" (route "${reason.route}")`
    default:
      return reason.message
  }
}

/** Whether a reason is retryable (RateLimit / ProviderInternal). */
const reasonRetryable = (reason: LLMErrorReason): boolean =>
  reason._tag === 'RateLimit' || reason._tag === 'ProviderInternal'

/** Retry-after delay in ms for reasons that carry one. */
const reasonRetryAfterMs = (reason: LLMErrorReason): number | undefined => {
  if (reason._tag === 'RateLimit' || reason._tag === 'ProviderInternal') {
    return reason.retryAfterMs
  }
  return undefined
}

type LLMError = {
  _tag: 'LLMError'
  module: string
  method: string
  reason: LLMErrorReason
  message: string
}

const llmError = (module: string, method: string, reason: LLMErrorReason): LLMError => ({
  _tag: 'LLMError',
  module,
  method,
  reason,
  message: `${module}.${method}: ${reasonMessage(reason)}`,
})

const isLLMError = (e: unknown): e is LLMError =>
  typeof e === 'object' && e !== null && (e as { _tag?: string })._tag === 'LLMError'

type ToolFailure = {
  _tag: 'ToolFailure'
  message: string
  metadata?: Record<string, unknown>
}

const toolFailure = (message: string, metadata?: Record<string, unknown>): ToolFailure => ({
  _tag: 'ToolFailure',
  message,
  metadata,
})

const isToolFailure = (e: unknown): e is ToolFailure =>
  typeof e === 'object' && e !== null && (e as { _tag?: string })._tag === 'ToolFailure'

export type { HttpContext, LLMError, LLMErrorReason, ToolFailure }
export {
  isLLMError,
  isToolFailure,
  llmError,
  reasonMessage,
  reasonRetryAfterMs,
  reasonRetryable,
  toolFailure,
}
```

- [ ] **Step 2: Write `src/llm/schema/errors.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import {
  isLLMError,
  llmError,
  reasonMessage,
  reasonRetryAfterMs,
  reasonRetryable,
  toolFailure,
} from './errors.js'

describe('schema/errors llmError', () => {
  it('builds a NoRoute error with auto message', () => {
    const err = llmError('LLM', 'resolve', {
      _tag: 'NoRoute',
      route: 'openai-chat',
      provider: 'openai',
      model: 'gpt-x',
    })
    expect(err.message).toBe(
      'LLM.resolve: No LLM route for model "gpt-x" using provider "openai" (route "openai-chat")',
    )
    expect(isLLMError(err)).toBe(true)
  })

  it('builds a RateLimit error', () => {
    const err = llmError('LLM', 'stream', {
      _tag: 'RateLimit',
      message: 'slow down',
      retryAfterMs: 2000,
    })
    expect(err.reason._tag).toBe('RateLimit')
  })

  it('isLLMError rejects plain errors', () => {
    expect(isLLMError(new Error('boom'))).toBe(false)
    expect(isLLMError(null)).toBe(false)
  })
})

describe('schema/errors retryable', () => {
  it('RateLimit and ProviderInternal are retryable', () => {
    expect(
      reasonRetryable({ _tag: 'RateLimit', message: 'x', retryAfterMs: 100 }),
    ).toBe(true)
    expect(reasonRetryable({ _tag: 'ProviderInternal', message: 'x', status: 503 })).toBe(true)
  })

  it('InvalidRequest is not retryable', () => {
    expect(reasonRetryable({ _tag: 'InvalidRequest', message: 'x' })).toBe(false)
  })

  it('context-overflow InvalidRequest is not retryable', () => {
    expect(
      reasonRetryable({ _tag: 'InvalidRequest', message: 'x', classification: 'context-overflow' }),
    ).toBe(false)
  })

  it('extracts retryAfterMs only from RateLimit/ProviderInternal', () => {
    expect(reasonRetryAfterMs({ _tag: 'RateLimit', message: 'x', retryAfterMs: 500 })).toBe(500)
    expect(reasonRetryAfterMs({ _tag: 'InvalidRequest', message: 'x' })).toBeUndefined()
  })
})

describe('schema/errors ToolFailure', () => {
  it('builds a ToolFailure', () => {
    const f = toolFailure('bad input', { code: 1 })
    expect(f.message).toBe('bad input')
    expect(f.metadata).toEqual({ code: 1 })
  })
})

describe('schema/errors reasonMessage', () => {
  it('returns the stored message for non-NoRoute reasons', () => {
    expect(reasonMessage({ _tag: 'Transport', message: 'tcp reset' })).toBe('tcp reset')
  })
})
```

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm test src/llm/schema/errors.test.ts`
Expected: PASS — 9 tests.
Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/llm/schema/errors.ts src/llm/schema/errors.test.ts
git commit -m "feat(llm): add schema errors (10-tag LLMErrorReason, LLMError factory, ToolFailure)"
```

---

### Task 5: Schema Barrel

**Files:**
- Create: `src/llm/schema/index.ts`

- [ ] **Step 1: Write `src/llm/schema/index.ts`**

```typescript
export * from './errors.js'
export * from './events.js'
export * from './ids.js'
export * from './messages.js'
export * from './options.js'
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/llm/schema/index.ts
git commit -m "feat(llm): add schema barrel export"
```

---

### Task 6: Context-Overflow Detection

**Files:**
- Create: `src/llm/provider-error.ts`
- Create: `src/llm/provider-error.test.ts`

- [ ] **Step 1: Write `src/llm/provider-error.ts`**

```typescript
import { isLLMError } from './schema/errors.js'
import type { LLMErrorReason } from './schema/errors.js'

const patterns: RegExp[] = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
]

/** True when a provider error message indicates the input exceeded the context window. */
const isContextOverflow = (message: string): boolean =>
  patterns.some((pattern) => pattern.test(message)) ||
  /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)

/** True when a thrown/produced value represents a context-overflow failure. */
const isContextOverflowFailure = (failure: unknown): boolean => {
  if (!isLLMError(failure)) return false
  const reason: LLMErrorReason = failure.reason
  return (
    reason._tag === 'InvalidRequest' && reason.classification === 'context-overflow'
  )
}

export { isContextOverflow, isContextOverflowFailure }
```

- [ ] **Step 2: Write `src/llm/provider-error.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import { isContextOverflow, isContextOverflowFailure } from './provider-error.js'
import { llmError } from './schema/errors.js'

describe('provider-error isContextOverflow', () => {
  it.each([
    'This model\'s maximum context length is 8192 tokens',
    'prompt is too long',
    'The request exceeds the context window',
    'Please reduce the length of the messages',
    'context_length_exceeded',
    'model_context_window_exceeded',
    '400 (no body)',
    '413 status code (no body)',
  ])('matches overflow phrase: %s', (msg) => {
    expect(isContextOverflow(msg)).toBe(true)
  })

  it.each(['everything is fine', 'rate limit exceeded', 'unauthorized'])(
    'does not match non-overflow phrase: %s',
    (msg) => {
      expect(isContextOverflow(msg)).toBe(false)
    },
  )
})

describe('provider-error isContextOverflowFailure', () => {
  it('detects a context-overflow LLMError', () => {
    const err = llmError('LLM', 'stream', {
      _tag: 'InvalidRequest',
      message: 'too long',
      classification: 'context-overflow',
    })
    expect(isContextOverflowFailure(err)).toBe(true)
  })

  it('rejects a non-overflow LLMError', () => {
    const err = llmError('LLM', 'stream', { _tag: 'RateLimit', message: 'slow' })
    expect(isContextOverflowFailure(err)).toBe(false)
  })

  it('rejects non-LLMError values', () => {
    expect(isContextOverflowFailure(new Error('x'))).toBe(false)
    expect(isContextOverflowFailure({ foo: 1 })).toBe(false)
  })
})
```

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm test src/llm/provider-error.test.ts`
Expected: PASS — 13 tests.
Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/llm/provider-error.ts src/llm/provider-error.test.ts
git commit -m "feat(llm): add context-overflow detection (19 regexes + status fallback)"
```

---

### Task 7: Retry Policy

**Files:**
- Create: `src/llm/retry.ts`
- Create: `src/llm/retry.test.ts`

- [ ] **Step 1: Write `src/llm/retry.ts`**

```typescript
import type { LLMError, LLMErrorReason } from './schema/errors.js'
import { isLLMError, llmError, reasonRetryAfterMs, reasonRetryable } from './schema/errors.js'

const RETRY_INITIAL_DELAY = 2_000
const RETRY_BACKOFF_FACTOR = 2
const RETRY_MAX_DELAY_NO_HEADERS = 30_000
const RETRY_MAX_DELAY = 2_147_483_647

/** Extract response headers from an LLMError's http context (if any). */
const errorHeaders = (error: unknown): Record<string, string> | undefined => {
  if (!isLLMError(error)) return undefined
  const reason = error.reason
  if ('http' in reason && reason.http?.response) {
    return reason.http.response.headers
  }
  return undefined
}

/** Cap a delay to the 32-bit safe ceiling. */
const capDelay = (ms: number): number => Math.min(ms, RETRY_MAX_DELAY)

/**
 * Compute the delay before the next retry attempt (ms).
 * Honors retry-after / retry-after-ms headers when present, else exponential backoff.
 */
const delay = (attempt: number, error?: unknown): number => {
  const headers = errorHeaders(error)
  if (headers) {
    const retryAfterMs = headers['retry-after-ms']
    if (retryAfterMs !== undefined) {
      const parsedMs = Number.parseFloat(retryAfterMs)
      if (!Number.isNaN(parsedMs)) return capDelay(parsedMs)
    }
    const retryAfter = headers['retry-after']
    if (retryAfter !== undefined) {
      const parsedSeconds = Number.parseFloat(retryAfter)
      if (!Number.isNaN(parsedSeconds)) return capDelay(Math.ceil(parsedSeconds * 1000))
      const parsed = Date.parse(retryAfter) - Date.now()
      if (!Number.isNaN(parsed) && parsed > 0) return capDelay(Math.ceil(parsed))
    }
    return capDelay(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
  }
  return capDelay(
    Math.min(
      RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1),
      RETRY_MAX_DELAY_NO_HEADERS,
    ),
  )
}

/** A normalized, retryable error descriptor for the session layer. */
type Retryable = {
  message: string
  reason: LLMErrorReason
}

/**
 * Decide whether a thrown error is retryable. Returns undefined when not retryable
 * (e.g. context overflow, auth, invalid request).
 */
const retryable = (error: unknown): Retryable | undefined => {
  if (!isLLMError(error)) return undefined
  const reason = error.reason
  if (!reasonRetryable(reason)) return undefined
  return { message: error.message, reason }
}

type RetryOptions = {
  maxRetries: number
  /** Override sleep for testing. Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>
  /** Called with each retry attempt metadata. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run an async operation with retry. Retries only on retryable LLM errors.
 * Non-retryable errors (including context overflow) are re-thrown immediately.
 */
const withRetry = async <T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> => {
  const sleep = options.sleep ?? defaultSleep
  let attempt = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn()
    } catch (error) {
      const canRetry = retryable(error)
      if (!canRetry || attempt >= options.maxRetries) throw error
      attempt += 1
      const delayMs =
        reasonRetryAfterMs(
          isLLMError(error) ? error.reason : { _tag: 'InvalidRequest', message: '' },
        ) ?? delay(attempt, error)
      options.onRetry?.({ attempt, delayMs, error })
      await sleep(delayMs)
    }
  }
}

export type { RetryOptions, Retryable }
export { RETRY_INITIAL_DELAY, RETRY_MAX_DELAY, RETRY_MAX_DELAY_NO_HEADERS, delay, retryable, withRetry }
```

- [ ] **Step 2: Write `src/llm/retry.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import { delay, retryable, withRetry } from './retry.js'
import { llmError } from './schema/errors.js'

const rateLimitError = (headers?: Record<string, string>) =>
  llmError('LLM', 'stream', {
    _tag: 'RateLimit',
    message: 'slow down',
    retryAfterMs: 100,
    http: headers
      ? {
          request: { method: 'POST', url: 'x', headers: {} },
          response: { status: 429, headers },
        }
      : undefined,
  })

const overflowError = () =>
  llmError('LLM', 'stream', {
    _tag: 'InvalidRequest',
    message: 'too long',
    classification: 'context-overflow',
  })

describe('retry delay', () => {
  it('uses exponential backoff without headers', () => {
    expect(delay(1)).toBe(2_000)
    expect(delay(2)).toBe(4_000)
    expect(delay(3)).toBe(8_000)
  })

  it('caps at RETRY_MAX_DELAY_NO_HEADERS (30s) without headers', () => {
    expect(delay(10)).toBe(30_000)
  })

  it('honors retry-after-ms header', () => {
    expect(delay(1, rateLimitError({ 'retry-after-ms': '750' }))).toBe(750)
  })

  it('honors retry-after seconds header', () => {
    expect(delay(1, rateLimitError({ 'retry-after': '3' }))).toBe(3_000)
  })

  it('falls back to exponential when header unparseable', () => {
    expect(delay(1, rateLimitError({ 'retry-after': 'not-a-date' }))).toBe(2_000)
  })
})

describe('retry retryable', () => {
  it('marks RateLimit as retryable', () => {
    expect(retryable(rateLimitError())).toBeDefined()
  })

  it('rejects context overflow', () => {
    expect(retryable(overflowError())).toBeUndefined()
  })

  it('rejects non-LLMError', () => {
    expect(retryable(new Error('x'))).toBeUndefined()
  })
})

describe('retry withRetry', () => {
  it('retries a retryable error then succeeds', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls += 1
        if (calls < 3) throw rateLimitError()
        return 'ok'
      },
      { maxRetries: 5, sleep: async () => {} },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('does not retry non-retryable errors', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw overflowError()
        },
        { maxRetries: 5, sleep: async () => {} },
      ),
    ).rejects.toBeDefined()
    expect(calls).toBe(1)
  })

  it('gives up after maxRetries', async () => {
    let calls = 0
    const attempts: number[] = []
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw rateLimitError()
        },
        { maxRetries: 2, sleep: async () => {}, onRetry: (i) => attempts.push(i.attempt) },
      ),
    ).rejects.toBeDefined()
    expect(calls).toBe(3)
    expect(attempts).toEqual([1, 2])
  })
})
```

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm test src/llm/retry.test.ts`
Expected: PASS — 10 tests.
Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/llm/retry.ts src/llm/retry.test.ts
git commit -m "feat(llm): add retry policy (delay, retryable classification, withRetry)"
```

---

### Task 8: Token Estimation

**Files:**
- Create: `src/llm/token.ts`
- Create: `src/llm/token.test.ts`

- [ ] **Step 1: Write `src/llm/token.ts`**

```typescript
/**
 * Heuristic token estimate: ~4 characters per token for English/code text.
 * This mirrors the common "chars / 4" approximation used by tiktoken's
 * rough estimate mode. A real BPE tokenizer can be plugged in later without
 * changing this signature.
 */
const TOKEN_CHARS_RATIO = 4

const estimateTokens = (text: string): number => {
  if (text.length === 0) return 0
  return Math.ceil(text.length / TOKEN_CHARS_RATIO)
}

export { estimateTokens }
```

- [ ] **Step 2: Write `src/llm/token.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import { estimateTokens } from './token.js'

describe('token estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('hello world!')).toBe(3) // 12 chars / 4
  })

  it('rounds up', () => {
    expect(estimateTokens('abcde')).toBe(2) // 5 chars → ceil(1.25)
  })
})
```

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm test src/llm/token.test.ts`
Expected: PASS — 3 tests.
Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/llm/token.ts src/llm/token.test.ts
git commit -m "feat(llm): add estimateTokens heuristic (chars/4)"
```

---

### Task 9: SSE Framing & HTTP Transport

**Files:**
- Create: `src/llm/transport.ts`
- Create: `src/llm/transport.test.ts`

- [ ] **Step 1: Write `src/llm/transport.ts`**

```typescript
import { isContextOverflow } from './provider-error.js'
import { llmError } from './schema/errors.js'

/**
 * Parse a Server-Sent Events byte stream into individual `data:` payloads.
 * Emits the decoded data string for each event block. Skips empty data and
 * the `[DONE]` sentinel. Works for both OpenAI (`data: {...}`) and Anthropic
 * (`event: {type}\ndata: {...}`) framing — only the `data:` lines are emitted.
 */
const sseFraming = async function* (
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE events are separated by a blank line
      let sepIndex: number
      while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sepIndex)
        buffer = buffer.slice(sepIndex + 2)
        const data = extractData(block)
        if (data !== null && data.length > 0 && data !== '[DONE]') {
          yield data
        }
      }
    }
    // flush any trailing event without a blank-line terminator
    const tailData = extractData(buffer)
    if (tailData !== null && tailData.length > 0 && tailData !== '[DONE]') {
      yield tailData
    }
  } finally {
    reader.releaseLock()
  }
}

/** Join all `data:` lines of an SSE block into one string. */
const extractData = (block: string): string | null => {
  const lines = block.split('\n')
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  if (dataLines.length === 0) return null
  return dataLines.join('\n')
}

type StreamHTTPOptions = {
  url: string
  body: unknown
  headers: Record<string, string>
  signal?: AbortSignal
  /** Injectable fetch (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * POST a JSON body and yield SSE data frames from the response.
 * Throws an LLMError on non-2xx responses, classifying context-overflow.
 */
const streamHTTP = async function* (
  options: StreamHTTPOptions,
): AsyncGenerator<string, void, unknown> {
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(options.body),
      signal: options.signal,
    })
  } catch (cause) {
    throw llmError('ProviderShared', 'request', {
      _tag: 'Transport',
      message: `Failed to send request to ${options.url}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      kind: 'network',
      url: options.url,
    })
  }

  if (!response.ok || response.body === null) {
    const text = await response.text().catch(() => '')
    throw classifyHttpError(response.status, text, options.url, response.headers)
  }

  yield* sseFraming(response.body)
}

/** Map an HTTP failure status + body to an LLMError. */
const classifyHttpError = (
  status: number,
  body: string,
  url: string,
  headers: Headers,
): ReturnType<typeof llmError> => {
  const http = {
    request: { method: 'POST', url, headers: {} },
    response: { status, headers: Object.fromEntries(headers.entries()) },
    body,
  }
  if (status === 401 || status === 403) {
    return llmError('ProviderShared', 'request', {
      _tag: 'Authentication',
      message: body || `Authentication failed (${status})`,
      kind: status === 401 ? 'invalid' : 'insufficient-permissions',
      http,
    })
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(headers.get('retry-after-ms'), headers.get('retry-after'))
    return llmError('ProviderShared', 'request', {
      _tag: 'RateLimit',
      message: body || 'Rate limited',
      retryAfterMs,
      http,
    })
  }
  if (status >= 500) {
    return llmError('ProviderShared', 'request', {
      _tag: 'ProviderInternal',
      message: body || `Provider error (${status})`,
      status,
      http,
    })
  }
  if (isContextOverflow(body)) {
    return llmError('ProviderShared', 'request', {
      _tag: 'InvalidRequest',
      message: body || 'Context overflow',
      classification: 'context-overflow',
      http,
    })
  }
  return llmError('ProviderShared', 'request', {
    _tag: 'UnknownProvider',
    message: body || `Unknown provider error (${status})`,
    status,
    http,
  })
}

const parseRetryAfterMs = (
  retryAfterMs?: string | null,
  retryAfter?: string | null,
): number | undefined => {
  if (retryAfterMs !== null && retryAfterMs !== undefined) {
    const parsed = Number.parseFloat(retryAfterMs)
    if (!Number.isNaN(parsed)) return Math.ceil(parsed)
  }
  if (retryAfter !== null && retryAfter !== undefined) {
    const parsed = Number.parseFloat(retryAfter)
    if (!Number.isNaN(parsed)) return Math.ceil(parsed * 1000)
  }
  return undefined
}

export { classifyHttpError, sseFraming, streamHTTP }
export type { StreamHTTPOptions }
```

- [ ] **Step 2: Write `src/llm/transport.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import { isLLMError } from './schema/errors.js'
import { sseFraming, streamHTTP } from './transport.js'

const toStream = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

const collect = async (gen: AsyncGenerator<string>): Promise<string[]> => {
  const out: string[] = []
  for await (const frame of gen) out.push(frame)
  return out
}

describe('transport sseFraming', () => {
  it('parses a single data frame', async () => {
    const frames = await collect(sseFraming(toStream(['data: {"a":1}\n\n'])))
    expect(frames).toEqual(['{"a":1}'])
  })

  it('parses multiple frames across chunk boundaries', async () => {
    const frames = await collect(
      sseFraming(toStream(['data: {"a":1}\n\ndata: {"b":2}\n\n'])),
    )
    expect(frames).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('handles split chunks', async () => {
    const frames = await collect(
      sseFraming(toStream(['data: {"a"', ':1}\n\n'])),
    )
    expect(frames).toEqual(['{"a":1}'])
  })

  it('joins multi-line data fields', async () => {
    const frames = await collect(
      sseFraming(toStream(['data: line1\ndata: line2\n\n'])),
    )
    expect(frames).toEqual(['line1\nline2'])
  })

  it('skips [DONE] sentinel and comments', async () => {
    const frames = await collect(
      sseFraming(toStream([': ping\ndata: [DONE]\n\ndata: {"x":1}\n\n'])),
    )
    expect(frames).toEqual(['{"x":1}'])
  })

  it('flushes a trailing frame without terminator', async () => {
    const frames = await collect(sseFraming(toStream(['data: {"tail":1}'])))
    expect(frames).toEqual(['{"tail":1}'])
  })
})

describe('transport streamHTTP', () => {
  const makeFetch = (
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): typeof fetch =>
    (async () =>
      new Response(body, {
        status,
        headers: { 'content-type': 'text/event-stream', ...headers },
      })) as unknown as typeof fetch

  it('yields frames on a 200 response', async () => {
    const frames = await collect(
      streamHTTP({
        url: 'https://example.com',
        body: { q: 1 },
        headers: {},
        fetchImpl: makeFetch(200, 'data: {"ok":true}\n\n'),
      }),
    )
    expect(frames).toEqual(['{"ok":true}'])
  })

  it('throws Authentication on 401', async () => {
    await expect(
      collect(
        streamHTTP({
          url: 'https://example.com',
          body: {},
          headers: {},
          fetchImpl: makeFetch(401, 'bad key'),
        }),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isLLMError(e)) return false
      return e.reason._tag === 'Authentication'
    })
  })

  it('throws RateLimit on 429 and parses retry-after-ms', async () => {
    await expect(
      collect(
        streamHTTP({
          url: 'https://example.com',
          body: {},
          headers: {},
          fetchImpl: makeFetch(429, 'slow', { 'retry-after-ms': '500' }),
        }),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isLLMError(e)) return false
      return e.reason._tag === 'RateLimit' && e.reason.retryAfterMs === 500
    })
  })

  it('throws context-overflow InvalidRequest when body matches', async () => {
    await expect(
      collect(
        streamHTTP({
          url: 'https://example.com',
          body: {},
          headers: {},
          fetchImpl: makeFetch(400, "This model's maximum context length is 8192 tokens"),
        }),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isLLMError(e)) return false
      return e.reason._tag === 'InvalidRequest' && e.reason.classification === 'context-overflow'
    })
  })

  it('throws ProviderInternal on 5xx', async () => {
    await expect(
      collect(
        streamHTTP({
          url: 'https://example.com',
          body: {},
          headers: {},
          fetchImpl: makeFetch(503, 'overloaded'),
        }),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isLLMError(e)) return false
      return e.reason._tag === 'ProviderInternal'
    })
  })
})
```

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm test src/llm/transport.test.ts`
Expected: PASS — 11 tests.
Run: `pnpm typecheck`
Expected: No errors.

> Note: `expect(...).rejects.toSatisfy(predicate)` requires Vitest 1.5+. If unavailable, replace with a try/catch assertion. The repo uses Vitest 3.x, so `toSatisfy` is available.

- [ ] **Step 4: Commit**

```bash
git add src/llm/transport.ts src/llm/transport.test.ts
git commit -m "feat(llm): add SSE framing and HTTP transport with error classification"
```

---

### Task 10: Protocol Utils — Tool Stream & Lifecycle

**Files:**
- Create: `src/llm/protocols/utils/tool-stream.ts`
- Create: `src/llm/protocols/utils/lifecycle.ts`
- Create: `src/llm/protocols/utils/tool-stream.test.ts`
- Create: `src/llm/protocols/utils/lifecycle.test.ts`
- Create: `src/llm/protocols/utils/index.ts`

- [ ] **Step 1: Write `src/llm/protocols/utils/tool-stream.ts`**

Accumulates streamed tool-call arguments keyed by the provider's stream index (OpenAI Chat uses the `index` field). Emits lifecycle + delta + finalized tool-call events.

```typescript
import type { ContentBlockID, ToolCallID } from '../../schema/ids.js'
import type {
  StreamEvent,
  ToolCallEvent,
  ToolInputDelta,
  ToolInputEnd,
  ToolInputStart,
} from '../../schema/events.js'
import { llmError } from '../../schema/errors.js'

type PendingTool = {
  id: ToolCallID
  name: string
  input: string
  started: boolean
}

type ToolStreamState = Record<number, PendingTool>

type DeltaInput = {
  index: number
  id?: string
  name?: string
  /** Fragment of the JSON arguments string. */
  argumentsDelta?: string
}

type AppendOutcome = {
  state: ToolStreamState
  events: StreamEvent[]
}

const empty = (): ToolStreamState => ({})

/**
 * Append a tool-call delta. If the index is new, emit a `tool-input-start`
 * (using the delta's id/name if present, else synthesized). Then emit a
 * `tool-input-delta` when an argument fragment is present.
 */
const appendOrStart = (
  state: ToolStreamState,
  delta: DeltaInput,
  missingToolMessage: string,
): AppendOutcome => {
  const current = state[delta.index]
  const events: StreamEvent[] = []
  let next: PendingTool
  if (current === undefined) {
    const id = delta.id
    const name = delta.name
    if (id === undefined || name === undefined) {
      throw llmError('ProviderShared', 'stream', {
        _tag: 'InvalidProviderOutput',
        message: missingToolMessage,
      })
    }
    next = { id, name, input: '', started: false }
    const start: ToolInputStart = { type: 'tool-input-start', id, name }
    events.push(start)
    next.started = true
  } else {
    next = { ...current }
  }
  if (delta.argumentsDelta !== undefined && delta.argumentsDelta.length > 0) {
    next.input += delta.argumentsDelta
    const d: ToolInputDelta = {
      type: 'tool-input-delta',
      id: next.id,
      name: next.name,
      text: delta.argumentsDelta,
    }
    events.push(d)
  }
  return { state: { ...state, [delta.index]: next }, events }
}

type FinishedTool = { id: ToolCallID; name: string; input: unknown }

type FinishAllOutcome = {
  state: ToolStreamState
  events: StreamEvent[]
  tools: FinishedTool[]
}

/** Parse a raw JSON arguments string; empty string becomes `{}`. */
const parseToolInput = (raw: string): unknown => {
  const source = raw.length === 0 ? '{}' : raw
  try {
    return JSON.parse(source)
  } catch {
    throw llmError('ProviderShared', 'stream', {
      _tag: 'InvalidProviderOutput',
      message: `Invalid JSON tool arguments: ${source}`,
      raw: source,
    })
  }
}

/**
 * Finalize all pending tool calls (OpenAI Chat style — no per-tool stop event).
 * Emits `tool-input-end` + parsed `tool-call` for each, and clears state.
 */
const finishAll = (state: ToolStreamState): FinishAllOutcome => {
  const events: StreamEvent[] = []
  const tools: FinishedTool[] = []
  for (const key of Object.keys(state)) {
    const tool = state[Number(key)]
    if (tool === undefined) continue
    const end: ToolInputEnd = { type: 'tool-input-end', id: tool.id, name: tool.name }
    events.push(end)
    const input = parseToolInput(tool.input)
    tools.push({ id: tool.id, name: tool.name, input })
    const call: ToolCallEvent = { type: 'tool-call', id: tool.id, name: tool.name, input }
    events.push(call)
  }
  return { state: {}, events, tools }
}

export type { AppendOutcome, DeltaInput, FinishAllOutcome, FinishedTool, ToolStreamState }
export { appendOrStart, empty, finishAll, parseToolInput }
```

- [ ] **Step 2: Write `src/llm/protocols/utils/lifecycle.ts`**

Tracks open content blocks per step and emits the surrounding lifecycle events. `stepStart` is idempotent within a step.

```typescript
import type { ContentBlockID, FinishReason } from '../../schema/ids.js'
import type { StreamEvent } from '../../schema/events.js'
import type { Usage } from '../../schema/events.js'

type LifecycleState = {
  stepStarted: boolean
  text: Set<ContentBlockID>
  reasoning: Set<ContentBlockID>
}

const initial = (): LifecycleState => ({
  stepStarted: false,
  text: new Set(),
  reasoning: new Set(),
})

type Result = { state: LifecycleState; events: StreamEvent[] }

const ensureStepStart = (state: LifecycleState, events: StreamEvent[]): LifecycleState => {
  if (state.stepStarted) return state
  events.push({ type: 'step-start', index: 0 })
  return { ...state, stepStarted: true }
}

const textDelta = (
  state: LifecycleState,
  events: StreamEvent[],
  id: ContentBlockID,
  text: string,
): Result => {
  const withStep = ensureStepStart(state, events)
  if (!withStep.text.has(id)) {
    events.push({ type: 'text-start', id })
    withStep.text.add(id)
  }
  events.push({ type: 'text-delta', id, text })
  return { state: withStep, events }
}

const reasoningDelta = (
  state: LifecycleState,
  events: StreamEvent[],
  id: ContentBlockID,
  text: string,
): Result => {
  const withStep = ensureStepStart(state, events)
  if (!withStep.reasoning.has(id)) {
    events.push({ type: 'reasoning-start', id })
    withStep.reasoning.add(id)
  }
  events.push({ type: 'reasoning-delta', id, text })
  return { state: withStep, events }
}

const closeOpenBlocks = (state: LifecycleState, events: StreamEvent[]): void => {
  for (const id of state.reasoning) events.push({ type: 'reasoning-end', id })
  for (const id of state.text) events.push({ type: 'text-end', id })
  state.reasoning.clear()
  state.text.clear()
}

type FinishInput = { reason: FinishReason; usage?: Usage }

/** Close any open blocks, then emit a step-finish and finish event; reset stepStarted. */
const finish = (state: LifecycleState, events: StreamEvent[], input: FinishInput): Result => {
  const withStep = ensureStepStart(state, events)
  closeOpenBlocks(withStep, events)
  events.push({ type: 'step-finish', index: 0, reason: input.reason, usage: input.usage })
  events.push({ type: 'finish', reason: input.reason, usage: input.usage })
  return { state: { ...withStep, stepStarted: false }, events }
}

export type { FinishInput, LifecycleState, Result }
export { closeOpenBlocks, finish, initial, reasoningDelta, textDelta }
```

- [ ] **Step 3: Write `src/llm/protocols/utils/tool-stream.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import { appendOrStart, empty, finishAll, parseToolInput } from './tool-stream.js'
import { isLLMError } from '../../schema/errors.js'

describe('tool-stream appendOrStart', () => {
  it('starts a tool on first delta and emits start + delta', () => {
    const { state, events } = appendOrStart(
      empty(),
      { index: 0, id: 't1', name: 'echo', argumentsDelta: '{"x":' },
      'missing',
    )
    expect(events).toEqual([
      { type: 'tool-input-start', id: 't1', name: 'echo' },
      { type: 'tool-input-delta', id: 't1', name: 'echo', text: '{"x":' },
    ])
    expect(state[0]?.input).toBe('{"x":')
  })

  it('appends to an existing tool without re-starting', () => {
    const started = appendOrStart(empty(), { index: 0, id: 't1', name: 'echo' }, 'm')
    const { state, events } = appendOrStart(
      started.state,
      { index: 0, argumentsDelta: '1}' },
      'missing',
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('tool-input-delta')
    expect(state[0]?.input).toBe('1}')
  })

  it('throws when starting without id or name', () => {
    expect(() => appendOrStart(empty(), { index: 0 }, 'need id')).toThrow()
    expect(() => appendOrStart(empty(), { index: 0 }, 'need id')).toThrow(
      expect.anything(),
    )
  })

  it('does not emit delta for empty argument fragments', () => {
    const { state, events } = appendOrStart(
      empty(),
      { index: 0, id: 't1', name: 'echo', argumentsDelta: '' },
      'm',
    )
    expect(events).toEqual([{ type: 'tool-input-start', id: 't1', name: 'echo' }])
    expect(state[0]?.input).toBe('')
  })
})

describe('tool-stream finishAll', () => {
  it('parses and emits tool-call events', () => {
    const { state } = appendOrStart(empty(), { index: 0, id: 't1', name: 'echo' }, 'm')
    const { events, tools } = finishAll(appendOrStart(state, { index: 0, argumentsDelta: '{"a":1}' }, 'm').state)
    expect(tools).toEqual([{ id: 't1', name: 'echo', input: { a: 1 } }])
    expect(events.some((e) => e.type === 'tool-call')).toBe(true)
    expect(events.some((e) => e.type === 'tool-input-end')).toBe(true)
  })

  it('treats empty input as {}', () => {
    expect(parseToolInput('')).toEqual({})
  })

  it('throws on invalid JSON', () => {
    expect(() => parseToolInput('{bad')).toThrow()
  })

  it('isLLMError is true for invalid tool JSON', () => {
    try {
      parseToolInput('{bad')
    } catch (e) {
      expect(isLLMError(e)).toBe(true)
    }
  })
})
```

- [ ] **Step 4: Write `src/llm/protocols/utils/lifecycle.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import { finish, initial, reasoningDelta, textDelta } from './lifecycle.js'
import { usageFrom } from '../../schema/events.js'

describe('lifecycle textDelta', () => {
  it('emits step-start + text-start + text-delta on first use', () => {
    const state = initial()
    const events: ReturnType<typeof textDelta>['events'] = []
    const r1 = textDelta(state, events, 'b1', 'hel')
    const r2 = textDelta(r1.state, r1.events, 'b1', 'lo')
    expect(r2.events.map((e) => e.type)).toEqual([
      'step-start',
      'text-start',
      'text-delta',
      'text-delta',
    ])
  })

  it('does not emit step-start twice', () => {
    const state = initial()
    const r1 = textDelta(state, [], 'b1', 'a')
    const r2 = textDelta(r1.state, [], 'b2', 'b')
    const allEvents = [...r1.events, ...r2.events]
    expect(allEvents.filter((e) => e.type === 'step-start')).toHaveLength(1)
  })
})

describe('lifecycle reasoningDelta', () => {
  it('emits reasoning-start before reasoning-delta', () => {
    const r = reasoningDelta(initial(), [], 'r1', 'think')
    expect(r.events.map((e) => e.type)).toEqual(['step-start', 'reasoning-start', 'reasoning-delta'])
  })
})

describe('lifecycle finish', () => {
  it('closes open blocks and emits step-finish + finish', () => {
    const afterText = textDelta(initial(), [], 'b1', 'hi')
    const r = finish(afterText.state, afterText.events, {
      reason: 'stop',
      usage: usageFrom({ inputTokens: 5, outputTokens: 2 }),
    })
    expect(r.events.map((e) => e.type)).toEqual([
      'step-start',
      'text-start',
      'text-delta',
      'text-end',
      'step-finish',
      'finish',
    ])
    expect(r.state.stepStarted).toBe(false)
  })

  it('finish with tool-calls reason closes reasoning blocks too', () => {
    const afterReasoning = reasoningDelta(initial(), [], 'r1', 'hmm')
    const r = finish(afterReasoning.state, afterReasoning.events, { reason: 'tool-calls' })
    expect(r.events.some((e) => e.type === 'reasoning-end')).toBe(true)
  })
})
```

- [ ] **Step 5: Write `src/llm/protocols/utils/index.ts`**

```typescript
export * from './lifecycle.js'
export * from './tool-stream.js'
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm test src/llm/protocols/utils/`
Expected: PASS — 11 tests.
Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/llm/protocols/utils/
git commit -m "feat(llm): add protocol utils (tool-stream accumulator, lifecycle state)"
```

---

### Task 11: OpenAI-Compatible Protocol

**Files:**
- Create: `src/llm/protocols/openai-compat.ts`
- Create: `src/llm/protocols/openai-compat.test.ts`

This protocol covers OpenAI Chat Completions plus all OpenAI-compatible providers (DeepSeek, Groq, Together, OpenRouter, etc.). The `reasoning_content` field (DeepSeek) is mapped to reasoning events. Body builder converts `InternalRequest` → OpenAI Chat body; the stream step converts each SSE JSON payload → `StreamEvent[]`.

- [ ] **Step 1: Write `src/llm/protocols/openai-compat.ts`**

```typescript
import type { GenerationOptions, RouteDefaults } from '../schema/options.js'
import type {
  ContentPart,
  InternalRequest,
  Message,
  ToolDefinition,
} from '../schema/messages.js'
import type { FinishReason, ProviderMetadata, ToolCallID } from '../schema/ids.js'
import type { StreamEvent } from '../schema/events.js'
import { llmError } from '../schema/errors.js'
import {
  appendOrStart,
  empty as emptyTools,
  finishAll,
  type ToolStreamState,
} from './utils/tool-stream.js'
import {
  finish as lifecycleFinish,
  initial as lifecycleInitial,
  reasoningDelta,
  textDelta,
  type LifecycleState,
} from './utils/lifecycle.js'

type OpenAIChatRole = 'system' | 'user' | 'assistant' | 'tool'

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type OpenAIMessage = {
  role: OpenAIChatRole
  content: string | OpenAIContentPart[]
  tool_call_id?: string
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
}

type OpenAITool = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

type OpenAIBody = {
  model: string
  messages: OpenAIMessage[]
  tools?: OpenAITool[]
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
  stream: true
  max_tokens?: number
  temperature?: number
  top_p?: number
  stream_options?: { include_usage: boolean }
}

/** Merge system parts into a single system string (OpenAI Chat has one system slot). */
const joinSystem = (request: InternalRequest): string =>
  request.system.map((p) => p.text).join('\n\n')

const toOpenAIContent = (part: ContentPart): OpenAIContentPart => {
  if (part.type === 'text') return { type: 'text', text: part.text }
  // tool-call / tool-result / reasoning are not emitted as user content here;
  // they belong to assistant/tool messages and are handled below.
  return { type: 'text', text: '' }
}

const messageToOpenAI = (msg: Message): OpenAIMessage | OpenAIMessage[] => {
  if (msg.role === 'system') {
    return { role: 'system', content: msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('') }
  }
  if (msg.role === 'tool') {
    const toolPart = msg.content.find((p) => p.type === 'tool-result')
    if (toolPart && toolPart.type === 'tool-result') {
      const text = toolPart.result.type === 'text' ? String(toolPart.result.value) : JSON.stringify(toolPart.result.value)
      return { role: 'tool', content: text, tool_call_id: toolPart.id }
    }
    return { role: 'tool', content: '' }
  }
  // user / assistant
  const textParts = msg.content.filter((p) => p.type === 'text')
  const toolCalls = msg.content.filter(
    (p): p is Extract<ContentPart, { type: 'tool-call' }> => p.type === 'tool-call',
  )
  const content: OpenAIContentPart[] | string =
    msg.role === 'user'
      ? (textParts.length > 0 ? textParts.map(toOpenAIContent) : [])
      : textParts.map((p) => (p.type === 'text' ? p.text : '')).join('')
  const message: OpenAIMessage = {
    role: msg.role as OpenAIChatRole,
    content,
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
    }))
  }
  return message
}

const toolToOpenAI = (tool: ToolDefinition): OpenAITool => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  },
})

/** Build an OpenAI Chat Completions request body from an InternalRequest. */
const bodyFrom = (request: InternalRequest): OpenAIBody => {
  const systemText = joinSystem(request)
  const messages: OpenAIMessage[] = []
  if (systemText.length > 0) {
    messages.push({ role: 'system', content: systemText })
  }
  for (const msg of request.messages) {
    const converted = messageToOpenAI(msg)
    if (Array.isArray(converted)) messages.push(...converted)
    else messages.push(converted)
  }
  const generation: GenerationOptions | undefined = request.generation
  const body: OpenAIBody = {
    model: request.model.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (request.tools.length > 0) {
    body.tools = request.tools.map(toolToOpenAI)
    if (request.toolChoice !== undefined) {
      body.tool_choice =
        request.toolChoice.type === 'tool'
          ? { type: 'function', function: { name: request.toolChoice.name } }
          : request.toolChoice.type
    }
  }
  if (generation?.maxTokens !== undefined) body.max_tokens = generation.maxTokens
  if (generation?.temperature !== undefined) body.temperature = generation.temperature
  if (generation?.topP !== undefined) body.top_p = generation.topP
  return body
}

type OpenAIDelta = {
  content?: string
  reasoning_content?: string
  reasoning?: string
  tool_calls?: {
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }[]
}

type OpenAIChoice = {
  delta?: OpenAIDelta
  finish_reason?: string | null
}

type OpenAIStreamChunk = {
  choices?: OpenAIChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

const mapFinishReason = (raw: string | null | undefined): FinishReason => {
  switch (raw) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls'
    case 'content_filter':
      return 'content-filter'
    default:
      return 'unknown'
  }
}

type StepState = {
  lifecycle: LifecycleState
  tools: ToolStreamState
}

const initialStepState = (): StepState => ({
  lifecycle: lifecycleInitial(),
  tools: emptyTools(),
})

/**
 * Fold one OpenAI stream chunk into (next state, events). When the chunk
 * carries a finish_reason or usage, the stream is finalized.
 */
const step = (
  state: StepState,
  chunk: OpenAIStreamChunk,
): { state: StepState; events: StreamEvent[]; done: boolean } => {
  const events: StreamEvent[] = []
  let lifecycle = state.lifecycle
  let tools = state.tools
  let done = false

  const choice = chunk.choices?.[0]
  if (choice !== undefined && choice.delta !== undefined) {
    const delta = choice.delta
    if (delta.content !== undefined && delta.content.length > 0) {
      const r = textDelta(lifecycle, events, 'text-main', delta.content)
      lifecycle = r.state
    }
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (reasoning !== undefined && reasoning.length > 0) {
      const r = reasoningDelta(lifecycle, events, 'reasoning-main', reasoning)
      lifecycle = r.state
    }
    if (delta.tool_calls !== undefined) {
      for (const tc of delta.tool_calls) {
        const missing = `OpenAI stream missing tool id/name at index ${tc.index}`
        const outcome = appendOrStart(
          tools,
          {
            index: tc.index,
            id: tc.id,
            name: tc.function?.name,
            argumentsDelta: tc.function?.arguments,
          },
          missing,
        )
        tools = outcome.state
        events.push(...outcome.events)
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      const finishTools = finishAll(tools)
      tools = finishTools.state
      events.push(...finishTools.events)
      const usage = chunk.usage
        ? {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cacheReadInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
            totalTokens: chunk.usage.total_tokens,
            providerMetadata: { openai: chunk.usage } as ProviderMetadata,
          }
        : undefined
      const fr = lifecycleFinish(lifecycle, events, {
        reason: mapFinishReason(choice.finish_reason),
        usage,
      })
      lifecycle = fr.state
      done = true
    }
  } else if (chunk.usage !== undefined) {
    // Final usage-only chunk (OpenAI sends this separately after [DONE] with stream_options)
    done = true
  }

  return { state: { lifecycle, tools }, events, done }
}

/** Parse a raw SSE data string into an OpenAI stream chunk; throws on bad JSON. */
const parseChunk = (routeId: string, raw: string): OpenAIStreamChunk => {
  try {
    return JSON.parse(raw) as OpenAIStreamChunk
  } catch {
    throw llmError(routeId, 'stream', {
      _tag: 'InvalidProviderOutput',
      message: `Invalid OpenAI stream event`,
      raw,
    })
  }
}

type RouteConfig = {
  id: string
  provider: string
  baseURL: string
  apiKey: string
  /** Optional extra headers (e.g. anthropic-version on compat proxies). */
  headers?: () => Record<string, string>
  defaults?: RouteDefaults
  /** Path override; defaults to /v1/chat/completions. */
  path?: string
}

/** Build a complete route descriptor for an OpenAI-compatible provider. */
const openAICompatRoute = (config: RouteConfig): {
  id: string
  provider: string
  protocol: 'openai-compat'
  baseURL: string
  path: string
  headers: () => Record<string, string>
  auth: { type: 'bearer'; apiKey: string }
  defaults?: RouteDefaults
} => ({
  id: config.id,
  provider: config.provider,
  protocol: 'openai-compat',
  baseURL: config.baseURL,
  path: config.path ?? '/v1/chat/completions',
  headers: config.headers ?? (() => ({})),
  auth: { type: 'bearer', apiKey: config.apiKey },
  defaults: config.defaults,
})

export type {
  OpenAIBody,
  OpenAIChatRole,
  OpenAIChoice,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIStreamChunk,
  OpenAITool,
  RouteConfig,
  StepState,
}
export {
  bodyFrom,
  initialStepState,
  mapFinishReason,
  openAICompatRoute,
  parseChunk,
  step,
}
```

- [ ] **Step 2: Write `src/llm/protocols/openai-compat.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import {
  bodyFrom,
  initialStepState,
  mapFinishReason,
  openAICompatRoute,
  parseChunk,
  step,
} from './openai-compat.js'
import { isLLMError } from '../schema/errors.js'
import { model } from '../schema/options.js'
import { messageAssistant, messageUser } from '../schema/messages.js'
import type { InternalRequest, ToolDefinition } from '../schema/messages.js'

const request = (extra?: Partial<InternalRequest>): InternalRequest => ({
  model: model('gpt-4o', 'openai'),
  system: [{ type: 'text', text: 'be nice' }],
  messages: [messageUser('hi')],
  tools: [],
  ...extra,
})

describe('openai-compat bodyFrom', () => {
  it('builds a basic chat body with system message', () => {
    const body = bodyFrom(request())
    expect(body.model).toBe('gpt-4o')
    expect(body.stream).toBe(true)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be nice' })
    expect(body.messages[1]?.role).toBe('user')
  })

  it('includes tools and tool_choice when provided', () => {
    const tools: ToolDefinition[] = [
      { name: 'echo', description: 'd', inputSchema: { type: 'object', properties: {} } },
    ]
    const body = bodyFrom(request({ tools, toolChoice: { type: 'auto' } }))
    expect(body.tools?.[0]?.function.name).toBe('echo')
    expect(body.tool_choice).toBe('auto')
  })

  it('maps assistant tool-call content to tool_calls', () => {
    const msg = messageAssistant('thinking...')
    msg.content.push({ type: 'tool-call', id: 't1', name: 'echo', input: { x: 1 } })
    const body = bodyFrom(request({ messages: [messageUser('hi'), msg] }))
    const assistant = body.messages.find((m) => m.role === 'assistant')
    expect(assistant?.tool_calls?.[0]?.function.name).toBe('echo')
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe('{"x":1}')
  })

  it('maps tool-result message to tool role', () => {
    const toolMsg: InternalRequest['messages'][number] = {
      role: 'tool',
      content: [{ type: 'tool-result', id: 't1', name: 'echo', result: { type: 'text', value: 'done' } }],
    }
    const body = bodyFrom(request({ messages: [messageUser('hi'), toolMsg] }))
    const tool = body.messages.find((m) => m.role === 'tool')
    expect(tool?.tool_call_id).toBe('t1')
    expect(tool?.content).toBe('done')
  })

  it('applies generation options', () => {
    const body = bodyFrom(request({ generation: { maxTokens: 100, temperature: 0.5 } }))
    expect(body.max_tokens).toBe(100)
    expect(body.temperature).toBe(0.5)
  })
})

describe('openai-compat step', () => {
  it('emits text deltas then finish', () => {
    let state = initialStepState()
    let allEvents: ReturnType<typeof step>['events'][number][] = []
    let res = step(state, { choices: [{ delta: { content: 'hel' } }] })
    state = res.state
    allEvents.push(...res.events)
    res = step(state, { choices: [{ delta: { content: 'lo' } }] })
    state = res.state
    allEvents.push(...res.events)
    res = step(state, {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    })
    expect(res.done).toBe(true)
    const textDeltas = allEvents.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text)
    expect(textDeltas.join('')).toBe('hello')
    const finish = res.events.find((e) => e.type === 'finish')
    expect(finish && 'usage' in finish && finish.usage?.totalTokens).toBe(7)
  })

  it('maps reasoning_content to reasoning deltas (DeepSeek)', () => {
    const res = step(initialStepState(), {
      choices: [{ delta: { reasoning_content: 'think' } }],
    })
    expect(res.events.some((e) => e.type === 'reasoning-delta')).toBe(true)
  })

  it('accumulates streaming tool calls and finalizes them', () => {
    let state = initialStepState()
    let res = step(state, {
      choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'echo', arguments: '{"x":' } }] } }],
    })
    state = res.state
    res = step(state, {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }],
    })
    state = res.state
    res = step(state, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    const toolCall = res.events.find((e) => e.type === 'tool-call')
    expect(toolCall && 'input' in toolCall && toolCall.input).toEqual({ x: 1 })
  })

  it('maps finish reasons', () => {
    expect(mapFinishReason('stop')).toBe('stop')
    expect(mapFinishReason('tool_calls')).toBe('tool-calls')
    expect(mapFinishReason('length')).toBe('length')
    expect(mapFinishReason('content_filter')).toBe('content-filter')
    expect(mapFinishReason(undefined)).toBe('unknown')
  })
})

describe('openai-compat parseChunk + route', () => {
  it('parses valid JSON', () => {
    const chunk = parseChunk('openai-chat', '{"choices":[]}')
    expect(chunk.choices).toEqual([])
  })

  it('throws InvalidProviderOutput on bad JSON', () => {
    try {
      parseChunk('openai-chat', '{bad')
      throw new Error('should not reach')
    } catch (e) {
      expect(isLLMError(e)).toBe(true)
    }
  })

  it('builds a route config', () => {
    const route = openAICompatRoute({
      id: 'deepseek',
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-x',
    })
    expect(route.path).toBe('/v1/chat/completions')
    expect(route.auth).toEqual({ type: 'bearer', apiKey: 'sk-x' })
  })
})
```

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm test src/llm/protocols/openai-compat.test.ts`
Expected: PASS — 13 tests.
Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/llm/protocols/openai-compat.ts src/llm/protocols/openai-compat.test.ts
git commit -m "feat(llm): add OpenAI-compatible protocol (body builder, stream step, route)"
```

---

### Task 12: Provider Registry & Capability DB

**Files:**
- Create: `src/llm/registry.ts`
- Create: `src/llm/registry.test.ts`

- [ ] **Step 1: Write `src/llm/registry.ts`**

```typescript
import type { ModelCapabilities } from '../shared/types/llm.js'
import type { ModelRole } from '../shared/types/llm.js'
import { model as makeModel } from './schema/options.js'
import type { Model } from './schema/options.js'
import { openAICompatRoute } from './protocols/openai-compat.js'
import { llmError } from './schema/errors.js'

type RouteEntry = ReturnType<typeof openAICompatRoute> & {
  models: Record<string, ModelCapabilities>
}

type Registry = {
  routes: Map<string, RouteEntry>
  roles: Map<string, { provider: string; model: string }>
}

const createRegistry = (): Registry => ({ routes: new Map(), roles: new Map() })

type ProviderInput = {
  name: string
  baseURL: string
  apiKey: string
  headers?: () => Record<string, string>
  path?: string
  models?: Record<string, ModelCapabilities>
}

const registerProvider = (registry: Registry, input: ProviderInput): void => {
  registry.routes.set(input.name, {
    ...openAICompatRoute({
      id: input.name,
      provider: input.name,
      baseURL: input.baseURL,
      apiKey: input.apiKey,
      headers: input.headers,
      path: input.path,
    }),
    models: input.models ?? {},
  })
}

type ResolveResult = {
  route: RouteEntry
  model: Model
  capabilities: ModelCapabilities
}

/**
 * Resolve a (provider, modelId) pair into a route + typed model.
 * Throws NoRoute when the provider is unknown.
 */
const resolveRoute = (registry: Registry, provider: string, modelId: string): ResolveResult => {
  const route = registry.routes.get(provider)
  if (route === undefined) {
    throw llmError('LLM', 'resolve', {
      _tag: 'NoRoute',
      route: `${provider}`,
      provider,
      model: modelId,
    })
  }
  const capabilities =
    route.models[modelId] ??
    ({
      contextWindow: 8192,
      maxOutput: 4096,
      supportsTools: true,
      supportsVision: false,
      supportsThinking: false,
      costPer1kInput: 0,
      costPer1kOutput: 0,
    } satisfies ModelCapabilities)
  return {
    route,
    model: makeModel(modelId, provider, {
      context: capabilities.contextWindow,
      output: capabilities.maxOutput,
    }),
    capabilities,
  }
}

/** Resolve the (provider, model) configured for a given role. */
const resolveModelByRole = (
  registry: Registry,
  role: ModelRole,
): { provider: string; model: string } => {
  const key = role._tag
  const entry = registry.roles.get(key)
  if (entry === undefined) {
    // fall back to the default role
    const fallback = registry.roles.get('default')
    if (fallback === undefined) {
      throw llmError('LLM', 'resolve', {
        _tag: 'NoRoute',
        route: `role:${key}`,
        provider: 'unknown',
        model: 'unknown',
      })
    }
    return fallback
  }
  return entry
}

/** Bind a role to a (provider, model) pair. */
const setRole = (
  registry: Registry,
  role: ModelRole,
  provider: string,
  model: string,
): void => {
  registry.roles.set(role._tag, { provider, model })
}

/** Default role + a starter catalog of well-known models. */
const builtinCapabilities: Record<string, Record<string, ModelCapabilities>> = {
  openai: {
    'gpt-4o': {
      contextWindow: 128000,
      maxOutput: 16384,
      supportsTools: true,
      supportsVision: true,
      supportsThinking: false,
      costPer1kInput: 0.0025,
      costPer1kOutput: 0.01,
    },
  },
  deepseek: {
    'deepseek-chat': {
      contextWindow: 64000,
      maxOutput: 8192,
      supportsTools: true,
      supportsVision: false,
      supportsThinking: false,
      costPer1kInput: 0.00014,
      costPer1kOutput: 0.00028,
    },
    'deepseek-reasoner': {
      contextWindow: 64000,
      maxOutput: 8192,
      supportsTools: false,
      supportsVision: false,
      supportsThinking: true,
      costPer1kInput: 0.00055,
      costPer1kOutput: 0.00219,
    },
  },
}

export type { ProviderInput, Registry, ResolveResult, RouteEntry }
export {
  builtinCapabilities,
  createRegistry,
  registerProvider,
  resolveModelByRole,
  resolveRoute,
  setRole,
}
```

- [ ] **Step 2: Write `src/llm/registry.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import {
  createRegistry,
  registerProvider,
  resolveModelByRole,
  resolveRoute,
  setRole,
} from './registry.js'
import { isLLMError } from './schema/errors.js'
import type { ModelRole } from '../shared/types/llm.js'

const defaultRole: ModelRole = { _tag: 'default' }

describe('registry register + resolveRoute', () => {
  it('resolves a registered provider and model with capabilities', () => {
    const reg = createRegistry()
    registerProvider(reg, {
      name: 'openai',
      baseURL: 'https://api.openai.com',
      apiKey: 'sk-x',
      models: { 'gpt-4o': { contextWindow: 128000, maxOutput: 16384, supportsTools: true, supportsVision: true, supportsThinking: false, costPer1kInput: 0, costPer1kOutput: 0 } },
    })
    const res = resolveRoute(reg, 'openai', 'gpt-4o')
    expect(res.model.id).toBe('gpt-4o')
    expect(res.capabilities.contextWindow).toBe(128000)
    expect(res.route.path).toBe('/v1/chat/completions')
  })

  it('uses default capabilities for unknown models', () => {
    const reg = createRegistry()
    registerProvider(reg, { name: 'groq', baseURL: 'https://x', apiKey: 'k' })
    const res = resolveRoute(reg, 'groq', 'llama-3-70b')
    expect(res.capabilities.contextWindow).toBe(8192) // fallback default
  })

  it('throws NoRoute for unknown provider', () => {
    const reg = createRegistry()
    try {
      resolveRoute(reg, 'ghost', 'm1')
      throw new Error('should not reach')
    } catch (e) {
      expect(isLLMError(e)).toBe(true)
    }
  })
})

describe('registry roles', () => {
  it('resolves a role to its configured provider/model', () => {
    const reg = createRegistry()
    registerProvider(reg, { name: 'openai', baseURL: 'https://x', apiKey: 'k' })
    setRole(reg, defaultRole, 'openai', 'gpt-4o')
    expect(resolveModelByRole(reg, defaultRole)).toEqual({ provider: 'openai', model: 'gpt-4o' })
  })

  it('falls back to default role when a specific role is unset', () => {
    const reg = createRegistry()
    registerProvider(reg, { name: 'deepseek', baseURL: 'https://x', apiKey: 'k' })
    setRole(reg, defaultRole, 'deepseek', 'deepseek-chat')
    const smolRole: ModelRole = { _tag: 'smol' }
    expect(resolveModelByRole(reg, smolRole)).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('throws NoRoute when no roles are configured', () => {
    const reg = createRegistry()
    try {
      resolveModelByRole(reg, defaultRole)
      throw new Error('should not reach')
    } catch (e) {
      expect(isLLMError(e)).toBe(true)
    }
  })
})
```

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm test src/llm/registry.test.ts`
Expected: PASS — 6 tests.
Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/llm/registry.ts src/llm/registry.test.ts
git commit -m "feat(llm): add provider registry with role routing and capability DB"
```

---

### Task 13: Role Routing & Fallback

**Files:**
- Create: `src/llm/routing.ts`
- Create: `src/llm/routing.test.ts`

`chatStreamWithFallback` orchestrates: try the primary route, retry on retryable errors, and on exhaustion switch to fallback routes. Context-overflow and auth errors never trigger fallback (they re-throw).

- [ ] **Step 1: Write `src/llm/routing.ts`**

```typescript
import type { Registry } from './registry.js'
import { resolveRoute } from './registry.js'
import type { LLMError } from './schema/errors.js'
import { isLLMError, reasonRetryable } from './schema/errors.js'
import { withRetry } from './retry.js'

type FallbackChain = {
  primary: { provider: string; model: string }
  fallbacks: { provider: string; model: string }[]
  maxRetries: number
  retryDelay: number
  /** Override sleep for testing. */
  sleep?: (ms: number) => Promise<void>
}

type RunFn<T> = (provider: string, model: string) => Promise<T>

/**
 * Run `run` against the primary route first. If it throws a retryable error
 * that exhausts retries, try each fallback in order. Non-retryable errors
 * (context overflow, auth, invalid request) propagate immediately without
 * trying fallbacks.
 */
const runWithFallback = async <T>(
  registry: Registry,
  chain: FallbackChain,
  run: RunFn<T>,
): Promise<{ result: T; provider: string; model: string }> => {
  const targets = [chain.primary, ...chain.fallbacks]
  let lastError: unknown

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i]
    if (target === undefined) continue
    // Validate the route exists before attempting (fails fast with NoRoute).
    resolveRoute(registry, target.provider, target.model)
    try {
      const result = await withRetry(() => run(target.provider, target.model), {
        maxRetries: chain.maxRetries,
        sleep: chain.sleep,
      })
      return { result, provider: target.provider, model: target.model }
    } catch (error) {
      lastError = error
      // Non-retryable errors do not fall through to fallback.
      if (!shouldFallOver(error)) throw error
    }
  }
  throw lastError
}

/**
 * Whether an error should trigger a fallback after retries are exhausted.
 * Only ProviderInternal (5xx/overloaded) and RateLimit fall over. Auth,
 * context-overflow, invalid request, and transport errors propagate.
 */
const shouldFallOver = (error: unknown): boolean => {
  if (!isLLMError(error)) return false
  const reason = error.reason
  if (reason._tag === 'ProviderInternal') return true
  if (reason._tag === 'RateLimit') return true
  return false
}

export type { FallbackChain }
export { runWithFallback, shouldFallOver }
```

- [ ] **Step 2: Write `src/llm/routing.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import { runWithFallback, shouldFallOver } from './routing.js'
import { createRegistry, registerProvider } from './registry.js'
import { llmError } from './schema/errors.js'
import { isLLMError } from './schema/errors.js'

const noSleep = async () => {}

const setup = () => {
  const reg = createRegistry()
  registerProvider(reg, { name: 'a', baseURL: 'https://a', apiKey: 'k' })
  registerProvider(reg, { name: 'b', baseURL: 'https://b', apiKey: 'k' })
  return reg
}

const internalError = () =>
  llmError('LLM', 'stream', { _tag: 'ProviderInternal', message: '500', status: 500 })
const authError = () =>
  llmError('LLM', 'stream', { _tag: 'Authentication', message: 'bad', kind: 'invalid' })
const overflowError = () =>
  llmError('LLM', 'stream', {
    _tag: 'InvalidRequest',
    message: 'x',
    classification: 'context-overflow',
  })

describe('routing shouldFallOver', () => {
  it('falls over on ProviderInternal', () => {
    expect(shouldFallOver(internalError())).toBe(true)
  })
  it('does not fall over on Authentication', () => {
    expect(shouldFallOver(authError())).toBe(false)
  })
  it('does not fall over on context overflow', () => {
    expect(shouldFallOver(overflowError())).toBe(false)
  })
  it('does not fall over on non-LLMError', () => {
    expect(shouldFallOver(new Error('x'))).toBe(false)
  })
})

describe('routing runWithFallback', () => {
  it('succeeds on the primary route', async () => {
    const res = await runWithFallback(
      setup(),
      { primary: { provider: 'a', model: 'm1' }, fallbacks: [], maxRetries: 0, retryDelay: 0, sleep: noSleep },
      async () => 'ok',
    )
    expect(res.result).toBe('ok')
    expect(res.provider).toBe('a')
  })

  it('falls over to the next route after a ProviderInternal', async () => {
    const calls: string[] = []
    const res = await runWithFallback(
      setup(),
      {
        primary: { provider: 'a', model: 'm1' },
        fallbacks: [{ provider: 'b', model: 'm2' }],
        maxRetries: 0,
        retryDelay: 0,
        sleep: noSleep,
      },
      async (provider) => {
        calls.push(provider)
        if (provider === 'a') throw internalError()
        return 'ok'
      },
    )
    expect(calls).toEqual(['a', 'b'])
    expect(res.provider).toBe('b')
  })

  it('does not fall over on auth errors', async () => {
    await expect(
      runWithFallback(
        setup(),
        {
          primary: { provider: 'a', model: 'm1' },
          fallbacks: [{ provider: 'b', model: 'm2' }],
          maxRetries: 0,
          retryDelay: 0,
          sleep: noSleep,
        },
        async () => {
          throw authError()
        },
      ),
    ).rejects.toSatisfy((e: unknown) => isLLMError(e) && e.reason._tag === 'Authentication')
  })

  it('retries retryable errors within a route before falling over', async () => {
    let primaryCalls = 0
    const res = await runWithFallback(
      setup(),
      {
        primary: { provider: 'a', model: 'm1' },
        fallbacks: [],
        maxRetries: 2,
        retryDelay: 0,
        sleep: noSleep,
      },
      async () => {
        primaryCalls += 1
        if (primaryCalls < 3) throw internalError()
        return 'recovered'
      },
    )
    expect(res.result).toBe('recovered')
    expect(primaryCalls).toBe(3)
  })

  it('throws the last error when all routes fail', async () => {
    await expect(
      runWithFallback(
        setup(),
        {
          primary: { provider: 'a', model: 'm1' },
          fallbacks: [{ provider: 'b', model: 'm2' }],
          maxRetries: 0,
          retryDelay: 0,
          sleep: noSleep,
        },
        async () => {
          throw internalError()
        },
      ),
    ).rejects.toSatisfy((e: unknown) => isLLMError(e))
  })
})
```

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm test src/llm/routing.test.ts`
Expected: PASS — 8 tests.
Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/llm/routing.ts src/llm/routing.test.ts
git commit -m "feat(llm): add fallback chain routing (retry + fall-over policy)"
```

---

### Task 14: Public Provider API — chatStream & chat

**Files:**
- Create: `src/llm/provider.ts`
- Create: `src/llm/provider.test.ts`

This is the public entrypoint. It maps the shared `ChatRequest` → `InternalRequest`, resolves the route, compiles the body, streams over HTTP, folds chunks into `StreamEvent`s, and maps each `StreamEvent` → the shared `StreamChunk` for downstream consumers (Plans 4-6).

- [ ] **Step 1: Write `src/llm/provider.ts`**

```typescript
import type {
  ChatMessage,
  ChatRequest,
  ChatTool,
  ContentPart as ChatContentPart,
  StreamChunk,
} from '../shared/types/llm.js'
import type { Registry } from './registry.js'
import { resolveRoute } from './registry.js'
import type { FallbackChain } from './routing.js'
import { runWithFallback } from './routing.js'
import { bodyFrom, initialStepState, parseChunk, step } from './protocols/openai-compat.js'
import type { StepState } from './protocols/openai-compat.js'
import { streamHTTP } from './transport.js'
import type { StreamEvent } from './schema/events.js'
import { isLLMError } from './schema/errors.js'
import { model as makeModel } from './schema/options.js'
import type {
  ContentPart,
  InternalRequest,
  Message,
  ToolDefinition,
} from './schema/messages.js'
import { llmError } from './schema/errors.js'

type ProviderContext = {
  registry: Registry
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

/** Map a shared ChatMessage to the internal Message shape. */
const toInternalMessage = (msg: ChatMessage): Message => {
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: [{ type: 'text', text: msg.content }] }
  }
  const parts: ContentPart[] = (msg.content as ChatContentPart[]).map((p) => {
    if (p.type === 'text') return { type: 'text' as const, text: p.text }
    return { type: 'text' as const, text: `[image: ${p.mediaType}]` }
  })
  // tool role messages carry tool result text
  if (msg.role === 'tool' && msg.toolCallId !== undefined) {
    const text = parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    return {
      role: 'tool',
      content: [
        { type: 'tool-result', id: msg.toolCallId, name: 'tool', result: { type: 'text', value: text } },
      ],
    }
  }
  // assistant messages may carry tool_calls
  if (msg.role === 'assistant' && msg.toolCalls !== undefined) {
    const toolParts: ContentPart[] = msg.toolCalls.map((tc) => ({
      type: 'tool-call',
      id: tc.id,
      name: tc.name,
      input: safeParseArgs(tc.arguments),
    }))
    return { role: 'assistant', content: [...parts, ...toolParts] }
  }
  return { role: msg.role, content: parts }
}

const safeParseArgs = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

const toInternalTool = (tool: ChatTool): ToolDefinition => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.parameters,
})

/** Map a rich StreamEvent to the shared, agent-facing StreamChunk. */
const toStreamChunk = (event: StreamEvent): StreamChunk | null => {
  switch (event.type) {
    case 'text-delta':
      return { _tag: 'text', text: event.text }
    case 'tool-input-start':
      return { _tag: 'tool_call_start', id: event.id, name: event.name }
    case 'tool-input-delta':
      return { _tag: 'tool_call_delta', id: event.id, argumentsDelta: event.text }
    case 'tool-input-end':
      return { _tag: 'tool_call_end', id: event.id }
    case 'tool-call':
      return { _tag: 'tool_call_end', id: event.id, argumentsFinal: JSON.stringify(event.input) }
    case 'reasoning-delta':
      return { _tag: 'thinking', text: event.text }
    case 'step-finish':
      if (event.usage !== undefined) {
        return {
          _tag: 'usage',
          inputTokens: event.usage.inputTokens ?? 0,
          outputTokens: event.usage.outputTokens ?? 0,
          cacheRead: event.usage.cacheReadInputTokens,
        }
      }
      return null
    case 'finish':
      return { _tag: 'done' }
    case 'provider-error':
      return {
        _tag: 'error',
        error: { message: event.message, retryable: event.retryable ?? false },
      }
    default:
      return null
  }
}

type ChatOptions = {
  provider: string
  model: string
  fallback?: FallbackChain
  /** Override sleep for retry testing. */
  sleep?: (ms: number) => Promise<void>
}

const buildInternalRequest = (
  request: ChatRequest,
  provider: string,
  modelId: string,
): InternalRequest => ({
  model: makeModel(modelId, provider),
  system: request.system !== undefined ? [{ type: 'text', text: request.system }] : [],
  messages: request.messages.map(toInternalMessage),
  tools: (request.tools ?? []).map(toInternalTool),
  generation: {
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  },
  toolChoice: request.tools !== undefined && request.tools.length > 0 ? { type: 'auto' } : undefined,
})

const collectEvents = async (
  ctx: ProviderContext,
  request: ChatRequest,
  options: ChatOptions,
): Promise<StreamEvent[]> => {
  const chain: FallbackChain =
    options.fallback ?? {
      primary: { provider: options.provider, model: options.model },
      fallbacks: [],
      maxRetries: 3,
      retryDelay: 2000,
      sleep: options.sleep,
    }

  const { result: events } = await runWithFallback(
    ctx.registry,
    chain,
    async (providerArg, modelArg) => {
      const resolved = resolveRoute(ctx.registry, providerArg, modelArg)
      const internal = buildInternalRequest(request, providerArg, modelArg)
      const body = bodyFrom(internal)
      const url = `${resolved.route.baseURL}${resolved.route.path}`
      const authHeader = resolved.route.auth.type === 'bearer' ? resolved.route.auth.apiKey : ''
      const collected: StreamEvent[] = []
      let state: StepState = initialStepState()
      for await (const frame of streamHTTP({
        url,
        body,
        headers: { authorization: `Bearer ${authHeader}`, ...resolved.route.headers() },
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
      })) {
        const chunk = parseChunk(resolved.route.id, frame)
        const result = step(state, chunk)
        state = result.state
        collected.push(...result.events)
        if (result.done) break
      }
      return collected
    },
  )
  return events
}

/**
 * Stream a chat request as agent-facing StreamChunk values.
 * Each yielded chunk is the normalized form Plans 4-6 consume.
 */
const chatStream = async function* (
  ctx: ProviderContext,
  request: ChatRequest,
  options: ChatOptions,
): AsyncGenerator<StreamChunk, void, unknown> {
  const events = await collectEvents(ctx, request, options)
  for (const event of events) {
    const chunk = toStreamChunk(event)
    if (chunk !== null) yield chunk
  }
}

/** Non-streaming chat: collect all events and return the final text. */
const chat = async (
  ctx: ProviderContext,
  request: ChatRequest,
  options: ChatOptions,
): Promise<string> => {
  const events = await collectEvents(ctx, request, options)
  return events
    .filter((e): e is Extract<StreamEvent, { type: 'text-delta' }> => e.type === 'text-delta')
    .map((e) => e.text)
    .join('')
}

export type { ChatOptions, ProviderContext }
export { buildInternalRequest, chat, chatStream, toInternalMessage, toStreamChunk }
```

- [ ] **Step 2: Write `src/llm/provider.test.ts`**

Uses an injectable `fetchImpl` returning a fixture SSE stream — no network needed.

```typescript
import { describe, expect, it } from 'vitest'
import type { ChatRequest } from '../shared/types/llm.js'
import { createRegistry, registerProvider } from './registry.js'
import { chat, chatStream } from './provider.js'

const sseFetch = (body: string): typeof fetch =>
  (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch

const setup = (body: string) => {
  const registry = createRegistry()
  registerProvider(registry, { name: 'mock', baseURL: 'https://mock', apiKey: 'k' })
  const ctx = { registry, fetchImpl: sseFetch(body) }
  return ctx
}

const request = (): ChatRequest => ({
  model: 'm1',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
})

describe('provider chatStream', () => {
  it('streams text deltas + usage + done', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    ].join('')
    const ctx = setup(sse)
    const chunks = []
    for await (const c of chatStream(ctx, request(), { provider: 'mock', model: 'm1' })) {
      chunks.push(c)
    }
    const text = chunks.filter((c) => c._tag === 'text').map((c) => (c as { text: string }).text).join('')
    expect(text).toBe('hello')
    expect(chunks.some((c) => c._tag === 'done')).toBe(true)
    const usage = chunks.find((c) => c._tag === 'usage') as {
      inputTokens: number
      outputTokens: number
    } | undefined
    expect(usage?.inputTokens).toBe(3)
  })

  it('streams thinking from reasoning_content', async () => {
    const sse = 'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n'
    const ctx = setup(sse)
    const chunks = []
    for await (const c of chatStream(ctx, request(), { provider: 'mock', model: 'm1' })) {
      chunks.push(c)
    }
    expect(chunks.some((c) => c._tag === 'thinking')).toBe(true)
  })

  it('streams a tool call through start/delta/end', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"echo","arguments":"{\\"x\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    ].join('')
    const ctx = setup(sse)
    const chunks = []
    for await (const c of chatStream(ctx, request(), { provider: 'mock', model: 'm1' })) {
      chunks.push(c)
    }
    expect(chunks.some((c) => c._tag === 'tool_call_start')).toBe(true)
    expect(chunks.some((c) => c._tag === 'tool_call_delta')).toBe(true)
    expect(chunks.some((c) => c._tag === 'tool_call_end')).toBe(true)
  })
})

describe('provider chat (non-streaming)', () => {
  it('returns the joined text', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"foo"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"bar"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    ].join('')
    const ctx = setup(sse)
    const text = await chat(ctx, request(), { provider: 'mock', model: 'm1' })
    expect(text).toBe('foobar')
  })
})
```

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm test src/llm/provider.test.ts`
Expected: PASS — 4 tests.
Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/llm/provider.ts src/llm/provider.test.ts
git commit -m "feat(llm): add public chatStream/chat API bridging ChatRequest to StreamChunk"
```

---

### Task 15: Barrel Export & Full Lint

**Files:**
- Modify: `src/llm/index.ts`

- [ ] **Step 1: Write `src/llm/index.ts`**

```typescript
export type { ChatOptions, ProviderContext } from './provider.js'
export { buildInternalRequest, chat, chatStream, toInternalMessage, toStreamChunk } from './provider.js'
export type { FallbackChain } from './routing.js'
export { runWithFallback, shouldFallOver } from './routing.js'
export {
  builtinCapabilities,
  createRegistry,
  registerProvider,
  resolveModelByRole,
  resolveRoute,
  setRole,
} from './registry.js'
export type { ProviderInput, Registry, ResolveResult } from './registry.js'
export { isContextOverflow, isContextOverflowFailure } from './provider-error.js'
export { delay, retryable, withRetry } from './retry.js'
export type { RetryOptions, Retryable } from './retry.js'
export { estimateTokens } from './token.js'
export { openAICompatRoute } from './protocols/openai-compat.js'
export type { RouteConfig } from './protocols/openai-compat.js'
export * from './schema/index.js'
```

- [ ] **Step 2: Run full LLM test suite**

Run: `pnpm test src/llm/`
Expected: All PASS — 97 tests across 13 files (3+7+4+7+9+13+10+3+11+11+13+6+8+4).

- [ ] **Step 3: Run full typecheck + lint**

Run: `pnpm typecheck`
Expected: No errors.
Run: `pnpm biome check --write src/`
Expected: Formatting/import-order auto-fixed; no lint errors remain.

- [ ] **Step 4: Commit**

```bash
git add src/llm/index.ts
git commit -m "feat(llm): add barrel export and complete LLM provider layer"
```

---

## Self-Review Notes

**Spec coverage:**
- §1 three-layer architecture → `Route` (data) + `Protocol` (openai-compat.ts body/stream) + `Transport` (transport.ts). ✓ (OpenAI-compat only; Anthropic/Gemini/Bedrock deferred.)
- §2 schema (ids/options/messages/events/errors) → Tasks 1-5. ✓
- §2.4 events (16-tag StreamEvent + Usage + LLMResponse) → Task 3. ✓
- §2.5 errors (10-tag LLMErrorReason + LLMError + ToolFailure) → Task 4. ✓
- §4.1 tool-stream accumulator (appendOrStart/finishAll) → Task 10. ✓ (simplified to OpenAI Chat style; Anthropic `start`/`finish`/`finishWithInput` variants deferred with the Anthropic protocol.)
- §4.2 lifecycle state machine → Task 10. ✓
- §5 retry policy (delay/retryable/withRetry, retry-after-ms priority) → Task 7. ✓
- §6 context-overflow detection (19 regexes + 400/413 fallback) → Task 6. ✓
- §7.2 OpenAI-compat route registration → Tasks 11-12. ✓
- §7.6 role routing + fallback → Tasks 12-13. ✓
- §7.7 OpenAI/DeepSeek reasoning_content → Task 11. ✓
- §3.6 estimateTokens → Task 8. ✓

**Deferred (intentionally, by YAGNI):** Anthropic Messages protocol, Bedrock Converse + binary event-stream framing, Gemini protocol, OpenAI Responses API, cache-breakpoint policy (§4.3 — only relevant to Anthropic/Bedrock which are deferred), WebSocket transport, `/v1/models` capability probing. Each deferred item has a clear seam (a new `protocols/*.ts` file + registry entry) when needed.

**Type consistency:** `StreamEvent.type` tags use kebab-case (`text-delta`); `StreamChunk._tag` uses snake_case (`tool_call_start`) matching the existing shared type. The bridge in `toStreamChunk` (Task 14) is the single mapping point — verified consistent across all events.

**Paradigm compliance:** No classes (all factory functions + plain-object `type`); branded IDs via intersection; `_tag` discriminated unions throughout; context-first args (`chatStream(ctx, request, options)`); ESM `.js` import extensions; `import type` for type-only imports.
