// 配置变更 diff：从「已加载的合并配置」与「当前草稿」计算最小 patch。
// 服务端 PATCH /api/config 按作用域落盘（applyScopedPatch，null=删除键），
// 因此 patch 只应包含真正变化的键，且删除用 null 显式表达（JSON 不传输 undefined）。

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function shallowEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 递归 diff：只保留相对 base 有变化的键。
 * - next 中新出现的键 → 原样放入；
 * - next 中值为 undefined 而 base 有值 → null（unset，回落另一作用域/默认值）；
 * - 嵌套普通对象 → 递归 diff，空结果不写入；
 * - 其余值用 JSON 序列化比较（数组整体比较）。
 */
export function diffConfig(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(next)) {
    const nextVal = next[key]
    const baseVal = base[key]
    if (nextVal === undefined) {
      if (baseVal !== undefined) patch[key] = null
      continue
    }
    if (isPlainObject(nextVal) && isPlainObject(baseVal)) {
      const sub = diffConfig(baseVal, nextVal)
      if (Object.keys(sub).length > 0) patch[key] = sub
      continue
    }
    if (!shallowEqual(nextVal, baseVal)) patch[key] = nextVal
  }
  // 只出现在 base 的键（JSON 编辑/导入删除场景）→ unset。
  for (const key of Object.keys(base)) {
    if (!(key in next)) patch[key] = null
  }
  return patch
}

/** patch 是否为空（所有递归层均无变化）。 */
export function isPatchEmpty(patch: Record<string, unknown>): boolean {
  for (const val of Object.values(patch)) {
    if (isPlainObject(val)) {
      if (!isPatchEmpty(val)) return false
    } else {
      return false
    }
  }
  return true
}
