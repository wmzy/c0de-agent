import { apiRequest } from './api.js'

/** 用量汇总（服务端从全部会话——含回收站内软删除会话——的 LLM 调用元数据聚合）。 */
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

export const usageAPI = {
  summary: () => apiRequest<UsageSummary>('/api/usage/summary'),
}
