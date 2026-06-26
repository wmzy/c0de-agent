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
