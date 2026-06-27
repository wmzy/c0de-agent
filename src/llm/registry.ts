import type { ModelCapabilities, ModelRole } from '../shared/types/llm.js'
import { openAICompatRoute } from './protocols/openai-compat.js'
import { llmError } from './schema/errors.js'
import type { Model } from './schema/options.js'
import { model as makeModel } from './schema/options.js'

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
const setRole = (registry: Registry, role: ModelRole, provider: string, model: string): void => {
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
