import { apiRequest } from './api.js'

/** 用量汇总（服务端从全部会话的 LLM 调用元数据聚合）。 */
export type UsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cost: number
  calls: number
}

export type UsageSummary = {
  totals: UsageTotals
  byMonth: Array<{ month: string } & UsageTotals>
  byModel: Array<{ model: string } & UsageTotals>
}

export const usageAPI = {
  summary: () => apiRequest<UsageSummary>('/api/usage/summary'),
}
