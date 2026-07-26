import type { ModelCapabilities, ModelOverride, ModelRole } from '../shared/types/llm.js'
import { openAICompatRoute } from './protocols/openai-compat.js'
import { llmError } from './schema/errors.js'
import type { Model } from './schema/options.js'
import { model as makeModel } from './schema/options.js'

type RouteEntry = ReturnType<typeof openAICompatRoute> & {
  models: Record<string, ModelCapabilities>
}

/**
 * Atomic, replaceable snapshot of every route + role binding.
 *
 * `Registry.table` is the single mutable field on a registry; `rebuildRegistry`
 * swaps it in one reference assignment, so a `resolveRoute` /
 * `resolveModelByRole` call firing at any moment observes a fully
 * self-consistent table — either the complete previous set or the complete
 * new set — never the half-cleared / half-registered intermediate that
 * clear()-then-register would expose to a concurrent reader.
 */
type RouteTable = {
  routes: Map<string, RouteEntry>
  roles: Map<string, { provider: string; model: string }>
}

type Registry = {
  table: RouteTable
}

const createRegistry = (): Registry => ({ table: { routes: new Map(), roles: new Map() } })

type ProviderInput = {
  name: string
  baseURL: string
  apiKey: string
  headers?: () => Record<string, string>
  path?: string
  models?: Record<string, ModelCapabilities>
}

const registerProvider = (registry: Registry, input: ProviderInput): void => {
  registry.table.routes.set(input.name, {
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
 * Default capabilities for models not explicitly declared in the route's models map.
 *
 * Modern models overwhelmingly support ≥128k context windows; the previous 8192
 * default caused false-positive compaction deadlocks on any provider that
 * didn't declare per-model capabilities. 128k is a conservative floor that
 * matches the most common modern context window.
 */
const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  contextWindow: 128_000,
  maxOutput: 8192,
  supportsTools: true,
  supportsVision: false,
  supportsThinking: false,
  costPer1kInput: 0,
  costPer1kOutput: 0,
}

/**
 * Merge sparse per-model overrides from config (ModelOverride) into full
 * ModelCapabilities by filling gaps with DEFAULT_MODEL_CAPABILITIES.
 * Strips `enabled` (a UI-only concern) — the registry tracks all models
 * regardless of selector visibility.
 */
function overrideToCapabilities(
  overrides: Record<string, ModelOverride>,
): Record<string, ModelCapabilities> {
  const result: Record<string, ModelCapabilities> = {}
  for (const [name, o] of Object.entries(overrides)) {
    result[name] = {
      contextWindow: o.contextWindow ?? DEFAULT_MODEL_CAPABILITIES.contextWindow,
      maxOutput: o.maxOutput ?? DEFAULT_MODEL_CAPABILITIES.maxOutput,
      supportsTools: o.supportsTools ?? DEFAULT_MODEL_CAPABILITIES.supportsTools,
      supportsVision: o.supportsVision ?? DEFAULT_MODEL_CAPABILITIES.supportsVision,
      supportsThinking: o.supportsThinking ?? DEFAULT_MODEL_CAPABILITIES.supportsThinking,
      costPer1kInput: o.costPer1kInput ?? DEFAULT_MODEL_CAPABILITIES.costPer1kInput,
      costPer1kOutput: o.costPer1kOutput ?? DEFAULT_MODEL_CAPABILITIES.costPer1kOutput,
    }
  }
  return result
}

/**
 * Resolve a (provider, modelId) pair into a route + typed model.
 * Throws NoRoute when the provider is unknown.
 */
const resolveRoute = (registry: Registry, provider: string, modelId: string): ResolveResult => {
  const route = registry.table.routes.get(provider)
  if (route === undefined) {
    throw llmError('LLM', 'resolve', {
      _tag: 'NoRoute',
      route: `${provider}`,
      provider,
      model: modelId,
    })
  }
  const capabilities = route.models[modelId] ?? DEFAULT_MODEL_CAPABILITIES
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
  const entry = registry.table.roles.get(key)
  if (entry === undefined) {
    const fallback = registry.table.roles.get('default')
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
const setRole = (registry: Registry, role: ModelRole, provider: string, model: string): void => {
  registry.table.roles.set(role._tag, { provider, model })
}

/**
 * Atomically rebuild the registry's routes + roles.
 *
 * `builder` populates a *detached* next registry via the normal
 * `registerProvider` / `setRole` API; only after it returns is the live
 * `table` pointer swapped in a single reference assignment. A reader that runs
 * at any point during the build therefore sees the previous complete table,
 * and the moment `rebuildRegistry` returns it sees the new complete table —
 * never the partial intermediate the builder is still filling.
 *
 * Prefer this over clear()-then-register whenever the registry is shared with
 * live request handlers (e.g. config hot-reload).
 */
const rebuildRegistry = (registry: Registry, builder: (next: Registry) => void): void => {
  const next = createRegistry()
  builder(next)
  registry.table = next.table
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

export type { ProviderInput, Registry, ResolveResult, RouteEntry, RouteTable }
export {
  builtinCapabilities,
  createRegistry,
  DEFAULT_MODEL_CAPABILITIES,
  overrideToCapabilities,
  rebuildRegistry,
  registerProvider,
  resolveModelByRole,
  resolveRoute,
  setRole,
}
