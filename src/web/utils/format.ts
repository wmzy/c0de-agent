import { roundTo } from '@shared/round.js'
import { isUuid } from '@shared/utils/string.js'
import type { CodeReference } from '@/types/index.js'

/** 解析输入文本中的代码引用 @[path:start-end] 或 @[msgId:n]。 */
export function parseCodeReference(text: string): CodeReference | null {
  const rangeMatch = text.match(/^@\[([^:]+):(\d+)-(\d+)\]$/)
  if (rangeMatch) {
    const [, path, start, end] = rangeMatch
    return {
      _tag: 'file',
      path: path ?? '',
      startLine: Number(start),
      endLine: Number(end),
    }
  }
  const singleMatch = text.match(/^@\[([^:]+):(\d+)\]$/)
  if (singleMatch) {
    const [, id, idx] = singleMatch
    // 消息 id 是 UUID（generateId = randomUUID）；此前按「含不含点」判定
    // 消息 vs 文件——无扩展名文件（README/Makefile/Dockerfile/src/foo）
    // 的单行引用被误判为消息引用，点击跳转到消息标签而非文件定位。
    if (isUuid(id ?? '')) {
      return { _tag: 'message', messageId: id ?? '', blockIndex: Number(idx) }
    }
    return { _tag: 'file', path: id ?? '', startLine: Number(idx), endLine: Number(idx) }
  }
  return null
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`
  return `${(n / 1000).toFixed(1)}k`
}

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/** 把美元花费格式化为可读字符串；极小额保留 4 位小数以避免被四舍五入为 $0。
 *  舍入经 roundTo 十进制语义：toFixed 直接作用于二进制近似值会把 1.005 显示成
 *  $1.00（少一分钱）。 */
export function formatCost(cost: number): string {
  if (cost < 0.0001) return '$0'
  if (cost < 0.01) return `$${roundTo(cost, 4).toFixed(4)}`
  return `$${roundTo(cost, 2).toFixed(2)}`
}

/** 数字输入框文本 → **有限**数值；空串/NaN/±Infinity（'1e999'）回落到 fallback。
 *
 *  `Number(v)` 会把 '1e999' 折成 Infinity 写进配置草稿：diff 出的 patch 里是
 *  Infinity，而 JSON 无法表示它——序列化后变 null，服务端 applyScopedPatch 视 null
 *  为「取消该键」，于是预算护栏/压缩阈值等键被静默删除（UI 仍回显「已保存」）。
 *  NaN/±Infinity/非数字文本一律回落到调用方给的当前值（= 本次编辑不生效），绝不写
 *  非有限数；空串沿用 Number('') 的 0（预算字段「0 = 不限制」依赖清空即清零）。 */
export function parseFiniteNumber(value: string, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 数字输入框文本 → **有限且落在 [min, max] 内**的数值。
 *
 * parseFiniteNumber 只挡非有限数，不挡越界值：数字输入框上写的 min/max 是给
 * 浏览器原生校验与步进器用的，React 受控 input 并不阻止用户键入 -1——实测设置页
 * 8 个声明了 min 的字段（最大重试次数/重试间隔/触发阈值/保留 Token/
 * 近期保留 Token/成功率阈值/最小样本数/子 Agent 并发数）全部照收 -1 并原样
 * 存进配置。
 *
 * 后果不是「显示难看」而是静默失效：fallback.maxRetries 存成 -1 后，
 * withRetry 里 `attempt >= Math.min(-1, policy.maxRetries)` 首次失败即成立，
 * 故障回退对全应用彻底停摆，而设置页仍显示「启用自动重试与回退」且提示
 * 「已保存」——用户没有任何线索知道自己关掉了一项容错能力。
 *
 * 越界时钳到边界而非回落到旧值：用户键入 -1 的意图是「不要负数」，钳到
 * min/0 既满足意图又比「恢复成上次保存的旧值」更可预期（后者会让人以为
 * 输入没生效而反复重输）。
 */
export function parseBoundedNumber(
  value: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const n = parseFiniteNumber(value, fallback)
  const { min, max } = bounds
  if (min !== undefined && n < min) return min
  if (max !== undefined && n > max) return max
  return n
}
