// 导入/JSON 编辑的配置形状守卫。
//
// 背景：设置页的表单把「已解析配置 + 草稿」浅合并后直接下发给各面板
// （Settings.tsx 的 `merged = { ...config, ...draft }`），而面板按 Config 类型
// 假定字段类型（如 CommaListInput 的 `value.join(', ')`）。此前导入只做
// `JSON.parse` 就把对象铺进表单，一份语法合法但结构不对的文件
// （例如 `{"plugins": {}}`、`{"tools": {"disabled": ["bash"]}}`）会让
// `merged.plugins.enabled` 变成 undefined → 渲染抛错 → 整页被 ErrorBoundary
// 替换成「页面渲染出错」，未保存的编辑一并丢失，用户也看不出是导入的文件有问题。
//
// 口径与「服务端读取配置」保持一致（src/core/config.ts 的 mergeConfig 把作用域
// 文件按一层展开合并进 DEFAULT_CONFIG）：缺失的键 = 用当前已解析值兜底，而不是
// 「该字段不存在」。因此归一化是「按当前形状逐层校验 + 补全」，只对**类别不符**
// （数组写成对象、字符串写成数字…）报错——那才是服务端也不会替你修的情况。
//
// 顶层未知键与 PATCH /api/config 同口径（collectUnknownConfigKeys）：拼写错误
// 在服务端会被 400 拒绝，提前在导入时指出更省事。

import type { Config } from '@shared/types/config.js'

/** 当前已解析配置里没有、但属于合法顶层键的可选键（服务端 KNOWN_CONFIG_KEYS 同集）。 */
const OPTIONAL_TOP_LEVEL_KEYS = ['commitModel']

/** 原型链键：合并/赋值会改写原型而非写入键（服务端 mergeConfig 同口径跳过）。 */
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * 已知「对象数组」键及其元素的最小形状模板（类型契约见 @shared/types 的
 * ProviderConfig / MCPServerConfig）。DEFAULT_CONFIG 里这些数组恒为 []，未配置
 * 用户导入/JSON 编辑时模板数组为空、无从逐元素比对；但面板按类型假定元素形状
 * （MCPPanel 读 server.name、CommaListInput 对 args 做 join），服务端 PATCH 又
 * 只校验 providers 不校验 mcpServers——畸形元素一旦放行就会直达渲染层炸整页、
 * 或毒化配置落盘。故模板数组为空时退回这里的内置模板校验元素形状；模板非空
 * 时仍按首个现有元素比对（既有口径）。
 */
const OBJECT_ARRAY_ELEMENT_TEMPLATES: Record<string, Record<string, unknown>> = {
  providers: { name: '', protocol: '', apiKey: '', baseURL: '', models: {} },
  mcpServers: { name: '', transport: '', command: '', args: [], url: '' },
}

type Kind = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' | 'undefined'

const KIND_LABEL: Record<Kind, string> = {
  string: '字符串',
  number: '数字',
  boolean: '布尔值',
  object: '对象',
  array: '数组',
  null: 'null',
  undefined: '缺失',
}

function kindOf(value: unknown): Kind {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return t
  if (t === 'object') return 'object'
  return 'undefined'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type WalkResult = { ok: true; value: unknown } | { ok: false; message: string }

/**
 * 按 `template`（当前已解析配置）的形状校验 `raw`。
 * - `fill=true`：缺失/null 的键用 template 的值补全（表单需要一个完整 Config）。
 *   数组元素不补全——整体替换语义下，把上一个 provider 的 baseURL 填进另一个
 *   provider 会静默改错端点。
 * - 数组整体替换：元素一律不允许 null/undefined（不是「清除该键」）；模板数组
 *   为空时，已知对象数组键退回 OBJECT_ARRAY_ELEMENT_TEMPLATES 校验元素形状。
 * - 模板里没有的键（含可选键）：无从比对，原样接受。
 */
function walk(raw: unknown, template: unknown, path: string, fill: boolean, key = ''): WalkResult {
  const tKind = kindOf(template)
  const rKind = kindOf(raw)
  // 模板缺失：当前配置里就没有这个字段，没有形状可校验。
  if (tKind === 'undefined') return { ok: true, value: raw }
  // 显式 null / 缺失：校验放行（JSON 视图中 null = 清除该键，diffConfig 同语义）；
  // 表单渲染需要完整值，补全模式下用当前值兜底。
  if (rKind === 'null' || rKind === 'undefined') {
    return fill ? { ok: true, value: template } : { ok: true, value: raw }
  }
  if (tKind !== rKind) {
    return {
      ok: false,
      message: `${path || '配置'}：应为${KIND_LABEL[tKind]}，实际是${KIND_LABEL[rKind]}`,
    }
  }
  if (tKind === 'array') {
    const rawArr = raw as unknown[]
    // 模板数组为空：已知对象数组键退回内置元素模板（见其注释），其余数组
    // 无从比对，维持放行。
    let templateItem = (template as unknown[])[0]
    if (templateItem === undefined) templateItem = OBJECT_ARRAY_ELEMENT_TEMPLATES[key]
    if (templateItem === undefined) return { ok: true, value: raw }
    const expected = KIND_LABEL[kindOf(templateItem)]
    for (let i = 0; i < rawArr.length; i++) {
      const itemKind = kindOf(rawArr[i])
      // 数组是整体替换语义：元素为 null/undefined 不是「清除该键」，而且会
      // 命中上面的 null 短路被放行（下游按对象取字段即炸），先在这里一律拦下。
      if (itemKind === 'null' || itemKind === 'undefined') {
        return {
          ok: false,
          message: `${path}[${i}]：应为${expected}，实际是${KIND_LABEL[itemKind]}`,
        }
      }
      const item = walk(rawArr[i], templateItem, `${path}[${i}]`, false)
      if (!item.ok) return item
    }
    return { ok: true, value: raw }
  }
  if (tKind === 'object') {
    const tObj = template as Record<string, unknown>
    const rObj = raw as Record<string, unknown>
    const out: Record<string, unknown> = fill ? { ...tObj } : rObj
    for (const key of Object.keys(rObj)) {
      if (PROTO_KEYS.has(key)) continue
      const child = walk(rObj[key], tObj[key], path ? `${path}.${key}` : key, fill, key)
      if (!child.ok) return child
      if (fill) out[key] = child.value
    }
    return { ok: true, value: out }
  }
  return { ok: true, value: raw }
}

/**
 * 表单补全模板：已加载配置为底，叠加草稿里**显式清除**的键（值为 undefined）。
 *
 * 为什么不能直接用 config：GUI 里的删除（取消勾选「一键提交使用独立模型」→
 * `commitModel: undefined`、清除标题生成模型 → `routing.smol: undefined`）在草稿里
 * 是「值为 undefined 的自有键」，而 JSON.stringify 会把它们整条丢掉——往返一次
 * JSON 视图后，用 config 当补全模板就正好把这个「用户刚做的删除」当成「文本里
 * 缺的键」按已落盘值补回来：复选框自己变回勾选，草稿与 config 又逐键相同，保存
 * diff 出空 patch 直接回显「✓ 已保存」，磁盘上什么都没变。
 *
 * 口径（与 walk 的补全语义配合）：
 * - 草稿里有该键且值为 undefined → 显式清除，模板里保持 undefined，删除得以保留；
 * - 草稿里没有该键 → 「文本没写」= 用当前已解析值兜底（walk 的既有口径），
 *   从底对象取；嵌套层同样逐层叠加，所以只写了 `tools.disabled` 的 JSON 文本
 *   切回表单时，`tools.enabled` 仍能按当前配置补全（不读 undefined）。
 */
function mergeTemplate(base: unknown, overlay: unknown): unknown {
  if (overlay === undefined) return undefined
  if (!isPlainObject(overlay) || !isPlainObject(base)) return overlay
  const out: Record<string, unknown> = { ...base }
  for (const key of Object.keys(overlay)) {
    if (PROTO_KEYS.has(key)) continue
    out[key] = mergeTemplate(base[key], overlay[key])
  }
  return out
}

/** 见 mergeTemplate：把「已加载配置 + 当前草稿的显式清除」做成表单补全模板。 */
export function fillTemplateWithUnsets(base: Config, draft: Partial<Config>): Config {
  return mergeTemplate(base, draft) as Config
}

/** 顶层未知键（服务端 PATCH 会以 UNKNOWN_CONFIG_KEYS 拒绝，此处提前指出）。 */
function unknownTopLevelKeys(raw: Record<string, unknown>, current: Config): string[] {
  const known = new Set([...Object.keys(current), ...OPTIONAL_TOP_LEVEL_KEYS])
  return Object.keys(raw).filter((k) => !known.has(k))
}

/**
 * 校验导入内容或 JSON 视图内容相对当前已解析配置的结构。
 * @returns 通过返回 null，否则返回可直接展示给用户的原因。
 */
export function validateConfigShape(raw: unknown, current: Config): string | null {
  if (!isPlainObject(raw)) return '配置必须是一个 JSON 对象'
  const unknown = unknownTopLevelKeys(raw, current)
  if (unknown.length > 0) {
    return `未知配置键：${unknown.join(', ')}（有效键：${Object.keys(current).join(', ')}）`
  }
  const result = walk(raw, current, '', false)
  return result.ok ? null : result.message
}

/**
 * 把（导入的 / JSON 视图的）配置归一化成可安全渲染的 Config：
 * 逐层按当前形状校验并补全缺失字段。
 * @returns 结构不符时 ok=false，`message` 为原因（形如 `plugins.enabled：应为数组，实际是字符串`）。
 */
export function normalizeConfigForForm(
  raw: unknown,
  current: Config,
): { ok: true; config: Config } | { ok: false; message: string } {
  const problem = validateConfigShape(raw, current)
  if (problem) return { ok: false, message: problem }
  const result = walk(raw, current, '', true)
  if (!result.ok) return { ok: false, message: result.message }
  return { ok: true, config: result.value as Config }
}

export { OPTIONAL_TOP_LEVEL_KEYS }
