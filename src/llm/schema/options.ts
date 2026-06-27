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
