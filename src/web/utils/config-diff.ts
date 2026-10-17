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
 * provider 行的客户端身份标记。
 *
 * 「留空 = 不修改」必须判到「同一行」：只有同一下标 + 同名才算同一行，否则
 * 「删掉一行再新增」会让新行继承上一行的密文。可名字恰恰是用户最爱改的字段——
 * 按下标配名的判据于是把「给 provider 改个名再保存」变成静默销毁密钥：改名行的
 * apiKey 是空串，配不上原行 → diff 写出 `apiKey: ''` → 服务端只加密非空明文，
 * 空串原样落盘覆盖密文，而界面回的是「✓ 已保存」，用户唯一的线索是那个绿色
 * 「已加密」徽章消失。
 *
 * 标记解决的就是这件事：用 symbol 属性给**已加载配置里的行**挂一枚身份，
 * 行随编辑被 `{…row}` 展开复制时标记跟着走（spread 复制自有可枚举 symbol），
 * 于是改名后的行仍能认回原行。symbol 键对 Object.keys / JSON.stringify 不可见，
 * 既不进 diff 也不进 PATCH body。
 *
 * 取值用 `Symbol.for('…@<下标>')` 而非新建 symbol：配置重新拉取（focus 重取、
 * 保存后失效重取）会产生一批**新的行对象**，`Symbol.for` 按下标全局唯一，
 * 保证重取前后同一位置拿到同一枚标记——否则「改了名的草稿行」在重取之后就再也
 * 认不回原行，缺陷换个时机照样复现。
 */
export const PROVIDER_ROW_ID: unique symbol = Symbol('c0de.providerRowId')

/** 给已加载配置里的 provider 行挂身份标记；已有标记的行不动（幂等）。 */
export function tagProviderRowIds(rows: unknown): void {
  if (!Array.isArray(rows)) return
  rows.forEach((row, index) => {
    if (!isPlainObject(row)) return
    const tagged = row as Record<PropertyKey, unknown>
    if (typeof tagged[PROVIDER_ROW_ID] === 'symbol') return
    tagged[PROVIDER_ROW_ID] = Symbol.for(`c0de.providerRow@${index}`)
  })
}

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
 * （要删就删整个 provider / 关掉该后端）。判定同时要求「同一行」：带 PROVIDER_ROW_ID
 * 标记的行按身份配对（改名字、改 URL 都还是同一行）；没有标记的行（用户新加的、
 * JSON 导入的）退回「同下标 + 同名」——否则「删掉第一行再新增一行」会让新增行的
 * 空密钥继承上一行的密文。
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
    // 身份表：已加载配置里带标记的行（见 PROVIDER_ROW_ID）。
    const savedByRowId = new Map<symbol, Record<string, unknown>>()
    for (const row of savedProviders) {
      if (!isPlainObject(row)) continue
      const rowId = (row as Record<PropertyKey, unknown>)[PROVIDER_ROW_ID]
      if (typeof rowId === 'symbol') savedByRowId.set(rowId, row)
    }
    next.providers = draft.providers.map((provider, index) => {
      if (!isPlainObject(provider) || provider.apiKey !== '') return provider
      const rowId = (provider as Record<PropertyKey, unknown>)[PROVIDER_ROW_ID]
      const savedRow: unknown = savedProviders[index]
      // 带标记的行按**身份**配对（改名/改 URL 都还是同一行）；没有标记的行只能
      // 退回「同下标 + 同名」这条旧判据，且只对**同样没有标记**的已保存行生效：
      // 已保存行一旦带了标记，从它展开出来的草稿行必然也带着标记——草稿行没标记
      // 就说明它不是那一行（用户新加的、JSON 导入的），不能让「同名」把别人的
      // 密文塞给它。
      const prev =
        typeof rowId === 'symbol'
          ? savedByRowId.get(rowId)
          : isPlainObject(savedRow) &&
              typeof (savedRow as Record<PropertyKey, unknown>)[PROVIDER_ROW_ID] !== 'symbol' &&
              savedRow.name === provider.name
            ? savedRow
            : undefined
      if (!isPlainObject(prev)) return provider
      if (typeof prev.apiKey !== 'string' || prev.apiKey === '') return provider
      restored++
      return { ...provider, apiKey: prev.apiKey }
    })
  }

  return { draft: next, restored }
}
