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
