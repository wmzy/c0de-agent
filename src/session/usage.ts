// src/session/usage.ts
// 成本账本工具：usage_events 的 backfill 与月度成本查询。
//
// usage_events（append-only，与 session 生命周期解耦）是成本聚合的权威数据源。
// 会话物理清除（回收站到期/彻底删除/临时会话清理）不触及它——成本是账本。
// 写路径在 loop manageSegment（每个 LLM 调用落一行）；本模块负责两条辅助路径：
//  1. backfillUsageEvents：把 sessions.metadata.segments 中已有调用补齐进账本
//     （升级前产生的历史数据 + fork 复制的 segments + 导入的会话）。
//     幂等：callId 唯一约束 + onConflictDoNothing，可安全重复执行。
//  2. budgetOverageParts：预算暂停/拒绝（usage.budgetAction='pause'）用的当月
//     金额 + token 双口径超支判定（token 兜底价格未知的自建网关/未登记模型）。

import { and, eq, gte } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { appMeta, sessions, usageEvents } from '../db/schema.js'
import type { UsageConfig } from '../shared/types/config.js'

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

/** 当月用量汇总（金额 + token），预算护栏判定用。
 *  cost：已发生成本——价格未知（cost=null）的调用按 $0 计入，故金额口径对自建
 *  网关/未登记模型会系统性低估；tokens：input+output+cacheRead tokens 之和，
 *  与价格无关，作为价格独立的兜底口径（缓存读取也按用量计费，须计入）。
 */
export async function monthUsage(
  handle: DB,
  opts: { projectId?: string | null; sinceMs: number },
): Promise<{ cost: number; tokens: number }> {
  const conds = [gte(usageEvents.timestamp, opts.sinceMs)]
  if (opts.projectId) conds.push(eq(usageEvents.projectId, opts.projectId))
  const rows = await handle.db
    .select({
      cost: usageEvents.cost,
      inputTokens: usageEvents.inputTokens,
      outputTokens: usageEvents.outputTokens,
      cacheRead: usageEvents.cacheRead,
    })
    .from(usageEvents)
    .where(and(...conds))
  let cost = 0
  let tokens = 0
  for (const r of rows) {
    if (typeof r.cost === 'number') cost += r.cost
    tokens += r.inputTokens + r.outputTokens + (r.cacheRead ?? 0)
  }
  return { cost, tokens }
}

/** 当月累计用量（本月 1 日 00:00 本地时区起算）。 */
export async function currentMonthUsage(
  handle: DB,
  projectId?: string | null,
  now = new Date(),
): Promise<{ cost: number; tokens: number }> {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  return monthUsage(handle, { projectId, sinceMs: monthStart })
}

/** 预算护栏判定：金额（USD）+ token 双口径，任一超支返回人类可读描述片段
 *  （空数组 = 未超支）。供 Web loop 暂停、CLI 拒绝、子 agent 提前中止共用。
 *  项目口径仅在 projectId 可归属时检查（未归属会话只受全局口径兜底）。
 *  token 口径独立于价格，兜底自建网关/未登记模型（cost 恒 $0）的场景。 */
export async function budgetOverageParts(
  handle: DB,
  usage: UsageConfig,
  projectId: string | null | undefined,
  now = new Date(),
): Promise<string[]> {
  const projectBudgetUsd = usage.monthlyBudgetUsd ?? 0
  const globalBudgetUsd = usage.globalMonthlyBudgetUsd ?? 0
  const projectTokenBudget = usage.monthlyTokenBudget ?? 0
  const globalTokenBudget = usage.globalMonthlyTokenBudget ?? 0
  const projectScoped = projectId != null && (projectBudgetUsd > 0 || projectTokenBudget > 0)
  const globalScoped = globalBudgetUsd > 0 || globalTokenBudget > 0
  if (!projectScoped && !globalScoped) return []

  const [project, global] = await Promise.all([
    projectScoped ? currentMonthUsage(handle, projectId, now) : Promise.resolve(null),
    globalScoped ? currentMonthUsage(handle, undefined, now) : Promise.resolve(null),
  ])

  const parts: string[] = []
  if (globalBudgetUsd > 0 && global && global.cost > globalBudgetUsd) {
    parts.push(`全局预算 $${globalBudgetUsd.toFixed(2)}：本月全部项目已 $${global.cost.toFixed(2)}`)
  }
  if (projectBudgetUsd > 0 && project && project.cost > projectBudgetUsd) {
    parts.push(`项目预算 $${projectBudgetUsd.toFixed(2)}：本项目已 $${project.cost.toFixed(2)}`)
  }
  if (globalTokenBudget > 0 && global && global.tokens > globalTokenBudget) {
    parts.push(
      `全局 token 预算 ${globalTokenBudget.toLocaleString()}：本月已 ${global.tokens.toLocaleString()} tokens`,
    )
  }
  if (projectTokenBudget > 0 && project && project.tokens > projectTokenBudget) {
    parts.push(
      `项目 token 预算 ${projectTokenBudget.toLocaleString()}：本项目已 ${project.tokens.toLocaleString()} tokens`,
    )
  }
  return parts
}

/** 本地时区的 YYYY-MM 月份键（与 usage 聚合、前端徽标同口径）。 */
export function localMonthKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 一次性 backfill 标记键（app_meta）。 */
export const USAGE_BACKFILL_MARKER = 'usage_backfill_v1'

/**
 * P3-8：backfill 只在「升级后的首次启动」执行一次，之后跳过——
 * backfill 的真实消费者只有升级前遗留 segments（fork 复制的 segments 经 callId
 * 唯一约束去重本就是 no-op；导入会话的 segments 已剥离 call id 不产生账本行），
 * 每次启动全表扫描是纯浪费。标记写入与 backfill 同事务，失败不落标记可重试。
 */
export async function backfillUsageEventsOnce(handle: DB): Promise<number> {
  const [marker] = await handle.db
    .select()
    .from(appMeta)
    .where(eq(appMeta.key, USAGE_BACKFILL_MARKER))
  if (marker) return 0
  const added = await backfillUsageEvents(handle)
  await handle.db.insert(appMeta).values({ key: USAGE_BACKFILL_MARKER, value: String(Date.now()) })
  return added
}
