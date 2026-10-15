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

/** 参与「留空 = 不修改」判定的密钥字段（与 ApiKeyInput 的使用点一一对应）。 */
const WEBSEARCH_SECRET_KEYS = ['tavilyApiKey', 'braveApiKey'] as const

/**
 * 保存前把草稿里「被清空的密钥字段」退回已保存的值，返回新草稿与被退回的字段数。
 *
 * 密钥输入框是密码框、且**不回显已加密的密文**（enc: 前缀留空显示，见 ApiKeyInput）：
 * 框里本来就是空的，用户无法分辨「本来就没有」与「我刚把它删掉了」。而清空是逐字符
 * 提交的（onChange → 草稿），于是「点进框里敲了几个字符、改主意又全删掉」会把空串
 * 提交进草稿；保存后 `apiKey: ''` 覆盖掉 enc: 密文——密钥永久丢失，没有确认、没有
 * 撤销，用户唯一的线索只是那个绿色徽章消失（服务端只对 length > 0 的明文加密，
 * 空串原样落盘，见 src/server/routes/config.ts）。
 *
 * 口径：**留空 = 不修改**。密码框里没有「可见的内容」可删，清空不表达删除意图
 * （要删就删整个 provider / 关掉该后端）。判定同时要求「同一行」：provider 按下标
 * 对应，且名字相同——否则「删掉第一行再新增一行」会让新增行的空密钥继承上一行的密文。
 */
export function restoreClearedSecrets(
  saved: Record<string, unknown>,
  draft: Record<string, unknown>,
): { draft: Record<string, unknown>; restored: number } {
  let restored = 0
  const next = { ...draft }

  const draftSearch = draft.websearch
  if (isPlainObject(draftSearch)) {
    const savedSearch = isPlainObject(saved.websearch) ? saved.websearch : {}
    const mergedSearch = { ...draftSearch }
    for (const key of WEBSEARCH_SECRET_KEYS) {
      const prev = savedSearch[key]
      if (mergedSearch[key] === '' && typeof prev === 'string' && prev !== '') {
        mergedSearch[key] = prev
        restored++
      }
    }
    next.websearch = mergedSearch
  }

  if (Array.isArray(draft.providers)) {
    const savedProviders = Array.isArray(saved.providers) ? saved.providers : []
    next.providers = draft.providers.map((provider, index) => {
      if (!isPlainObject(provider) || provider.apiKey !== '') return provider
      const prev = savedProviders[index]
      if (!isPlainObject(prev) || prev.name !== provider.name) return provider
      if (typeof prev.apiKey !== 'string' || prev.apiKey === '') return provider
      restored++
      return { ...provider, apiKey: prev.apiKey }
    })
  }

  return { draft: next, restored }
}
