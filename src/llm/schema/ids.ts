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
