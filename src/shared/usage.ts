import type { LLMSegment } from './types/agent.js'
import type { SessionUsage } from './types/session-view.js'

/** 从 metadata.segments 聚合会话级用量（跨段跨 call 累加，零额外查询）。
 *  服务端会话树（session/branch.ts 的 sessionUsage）与 Web 会话信息面板
 *  （SessionSummary）共用同一实现——此前两层各持一份聚合副本，token/成本
 *  口径（如 cacheRead 是否计入）会静默漂移。
 *  cost 口径（H2）：价格未知（cost=null）的调用按 $0 计入并单独计数，
 *  UI 据此提示金额系统性低估。 */
export function aggregateSegmentUsage(segments: LLMSegment[]): SessionUsage {
  // s.calls ?? []：容忍 legacy 段数据缺 calls（此前仅 branch 侧防御，收敛保留）。
  const calls = segments.flatMap((s) => s.calls ?? [])
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let cost = 0
  let unknownCostCalls = 0
  for (const c of calls) {
    inputTokens += c.usage.input
    outputTokens += c.usage.output
    cacheRead += c.usage.cacheRead ?? 0
    if (c.cost == null) {
      unknownCostCalls += 1
    } else {
      cost += c.cost
    }
  }
  return { inputTokens, outputTokens, cacheRead, cost, unknownCostCalls, calls: calls.length }
}
