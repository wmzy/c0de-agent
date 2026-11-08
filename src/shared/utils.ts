/** Generate a UUID v4 string.
 *  globalThis.crypto.randomUUID：node>=18 与浏览器均内置；极老运行时退化兜底
 *  （唯一性弱于 v4 但可用）。不再依赖 node:crypto，web 侧可直接复用本实现。 */
function generateId(): string {
  const c = globalThis.crypto
  return c && typeof c.randomUUID === 'function'
    ? c.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Current timestamp in milliseconds since epoch. */
function now(): number {
  return Date.now()
}

export { generateId, now }
