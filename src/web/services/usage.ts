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
  /** P1-4：服务端权威「本月」聚合（key + 统计），客户端不再自行按时区计算。 */
  currentMonth: { key: string } & UsageTotals
  /** P1-3：未归属任何项目的调用聚合（仅全局视图下发）。 */
  unassigned?: UsageTotals
  byMonth: Array<{ month: string } & UsageTotals>
  byModel: Array<{ model: string } & UsageTotals>
}

export const usageAPI = {
  /** projectId 提供时聚合该项目口径（项目设置页预算按本项目成本对比）。 */
  summary: (projectId?: string) =>
    apiRequest<UsageSummary>(
      `/api/usage/summary${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
}
