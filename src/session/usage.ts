// src/session/usage.ts
// 成本账本工具：usage_events 的 backfill 与月度成本查询。
//
// usage_events（append-only，与 session 生命周期解耦）是成本聚合的权威数据源。
// 会话物理清除（回收站到期/彻底删除/临时会话清理）不触及它——成本是账本。
// 写路径在 loop manageSegment（每个 LLM 调用落一行）；本模块负责两条辅助路径：
//  1. backfillUsageEvents：把 sessions.metadata.segments 中已有调用补齐进账本
//     （升级前产生的历史数据 + fork 复制的 segments + 导入的会话）。
//     幂等：callId 唯一约束 + onConflictDoNothing，可安全重复执行。
//  2. monthCost：预算暂停（usage.budgetAction='pause'）用的当月成本查询。

import { and, eq, gte } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { sessions, usageEvents } from '../db/schema.js'

/** segments 中单次调用的宽松形状（metadata JSON 反序列化后字段可能漂移）。 */
type SegmentCall = {
  id?: unknown
  timestamp?: unknown
  usage?: { input?: unknown; output?: unknown; cacheRead?: unknown }
  cost?: unknown
}

type SegmentRecord = {
  provider?: unknown
  model?: unknown
  calls?: SegmentCall[]
}

/**
 * 把 sessions.metadata.segments 中全部调用补齐进 usage_events（幂等）。
 * 覆盖：升级前历史数据、fork 复制的 segments（display 用途）、导入会话携带的
 * segments。callId 冲突（已入账）静默跳过。
 * 返回本次新增行数。
 */
export async function backfillUsageEvents(handle: DB): Promise<number> {
  const rows = await handle.db
    .select({ id: sessions.id, projectId: sessions.projectId, metadata: sessions.metadata })
    .from(sessions)

  let added = 0
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as { segments?: SegmentRecord[] }
    for (const seg of meta.segments ?? []) {
      if (typeof seg.provider !== 'string' || typeof seg.model !== 'string') continue
      for (const call of seg.calls ?? []) {
        if (typeof call.id !== 'string' || call.id.length === 0) continue
        const ts = typeof call.timestamp === 'number' && call.timestamp > 0 ? call.timestamp : 0
        if (ts === 0) continue
        const input = typeof call.usage?.input === 'number' ? call.usage.input : 0
        const output = typeof call.usage?.output === 'number' ? call.usage.output : 0
        const cacheRead = typeof call.usage?.cacheRead === 'number' ? call.usage.cacheRead : 0
        const cost = typeof call.cost === 'number' ? call.cost : null
        const result = await handle.db
          .insert(usageEvents)
          .values({
            callId: call.id,
            sessionId: row.id,
            projectId: row.projectId,
            provider: seg.provider,
            model: seg.model,
            inputTokens: input,
            outputTokens: output,
            cacheRead,
            cost,
            timestamp: ts,
          })
          .onConflictDoNothing()
        if (result.rowCount && result.rowCount > 0) added += result.rowCount
      }
    }
  }
  return added
}

/** 当月成本汇总（预算暂停判定用；cost=null 按 $0 计，另计未知次数）。 */
export async function monthCost(
  handle: DB,
  opts: { projectId?: string | null; sinceMs: number },
): Promise<{ cost: number; unknownCostCalls: number }> {
  const conds = [gte(usageEvents.timestamp, opts.sinceMs)]
  if (opts.projectId) conds.push(eq(usageEvents.projectId, opts.projectId))
  const rows = await handle.db
    .select({ cost: usageEvents.cost })
    .from(usageEvents)
    .where(and(...conds))
  let cost = 0
  let unknownCostCalls = 0
  for (const r of rows) {
    if (typeof r.cost === 'number') cost += r.cost
    else unknownCostCalls += 1
  }
  return { cost, unknownCostCalls }
}

/** 当月累计成本（本月 1 日 00:00 本地时区起算），返回 {cost, unknownCostCalls}。 */
export async function currentMonthCost(
  handle: DB,
  projectId?: string | null,
  now = new Date(),
): Promise<{ cost: number; unknownCostCalls: number }> {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  return monthCost(handle, { projectId, sinceMs: monthStart })
}

/** 本地时区的 YYYY-MM 月份键（与 usage 聚合、前端徽标同口径）。 */
export function localMonthKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
