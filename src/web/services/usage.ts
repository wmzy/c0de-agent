import type { UsageSummary, UsageTotals } from '@shared/types/usage.js'
import { get, withProjectId } from '@/services/api.js'

// 契约正本在 @shared/types/usage.ts（与服务端 usage 路由共用的响应形状）。
export type { UsageSummary, UsageTotals }

export const usageAPI = {
  /** projectId 提供时聚合该项目口径（项目设置页预算按本项目成本对比）。 */
  summary: (projectId?: string) =>
    get<UsageSummary>(withProjectId('/api/usage/summary', projectId)),
}

/** 用量汇总查询选项：键 + queryFn 单源（TopBar 徽标与 UsagePanel 共享缓存，
 *  projectId 缺省键为 'all' 全局口径）；staleTime/refetchInterval 留给各观察者。 */
export function usageSummaryQueryOptions(projectId?: string) {
  return {
    queryKey: ['usage', 'summary', projectId ?? 'all'] as const,
    queryFn: () => usageAPI.summary(projectId),
  }
}
