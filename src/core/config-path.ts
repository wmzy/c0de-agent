// 配置点路径（a.b.c）读写工具：CLI `config set/get` 与斜杠 `/config` 共用。

/** 按 a.b.c 点路径从对象取值；找不到抛错。 */
function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') throw new Error(`config: key "${path}" not found`)
    cur = (cur as Record<string, unknown>)[p]
    if (cur === undefined) throw new Error(`config: key "${path}" not found`)
  }
  return cur
}

/** 按 a.b.c 点路径写值（创建中间对象）。 */
function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i] as string
    const next = cur[k]
    cur[k] = (next !== null && typeof next === 'object' ? next : {}) as Record<string, unknown>
    cur = cur[k] as Record<string, unknown>
  }
  cur[parts[parts.length - 1] as string] = value
}

/** 把字符串解析为合适的标量类型。 */
function coerce(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** 构造 a.b.c → { a: { b: { c: value } } } 的 patch 对象。 */
function setPathPatch(path: string, value: unknown): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  setByPath(root, path, value)
  return root
}

export { coerce, getByPath, setByPath, setPathPatch }
