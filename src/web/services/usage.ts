import { apiRequest } from './api.js'

/** 用量汇总（服务端从 usage_events 成本账本聚合；?projectId= 过滤为项目口径）。 */
export type UsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cost: number
  /** 价格未知、按 $0 计入的调用数（H2：UI 需提示成本可能低估）。 */
  unknownCostCalls: number
  calls: number
}

export type UsageSummary = {
  totals: UsageTotals
  /** 内置价目表最近核价日期（H3：估算可能随价格变动过期）。 */
  priceCatalogVersion: string
  byMonth: Array<{ month: string } & UsageTotals>
  byModel: Array<{ model: string } & UsageTotals>
}

/** 本地时区的 YYYY-MM 月份键（与服务端 localMonthKey 同口径）。 */
export function localMonthKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export const usageAPI = {
  /** projectId 提供时聚合该项目口径（项目设置页预算按本项目成本对比）。 */
  summary: (projectId?: string) =>
    apiRequest<UsageSummary>(
      `/api/usage/summary${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
}
