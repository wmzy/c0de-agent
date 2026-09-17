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
 *  unknownCostCalls：当月价格未知的调用数——金额预算轴据此识别「口径低估」，
 *  无 token 预算兜底时并入护栏告警文案（P2-2：预算静默失效不再无提示）。
 */
export async function monthUsage(
  handle: DB,
  opts: { projectId?: string | null; sinceMs: number },
): Promise<{ cost: number; tokens: number; unknownCostCalls: number }> {
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
  let unknownCostCalls = 0
  for (const r of rows) {
    if (typeof r.cost === 'number') cost += r.cost
    else unknownCostCalls += 1
    tokens += r.inputTokens + r.outputTokens + (r.cacheRead ?? 0)
  }
  return { cost, tokens, unknownCostCalls }
}

/** 当月累计用量（本月 1 日 00:00 本地时区起算）。
 *  已知限制：跨时区/换机时「本月」边界随本地时区漂移，成本护栏阈值随之平移——
 *  本地单机（服务端与用户同机）场景无影响。 */
export async function currentMonthUsage(
  handle: DB,
  projectId?: string | null,
  now = new Date(),
): Promise<{ cost: number; tokens: number; unknownCostCalls: number }> {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  return monthUsage(handle, { projectId, sinceMs: monthStart })
}

/** 预算护栏判定结果：parts 为超支描述片段，action 为实际超支轴中最严格的动作
 *  （'abort' > 'pause'；'warn' 不阻断、不会进入本判定）。
 *  warnings：非阻断的告警片段（P2-2）——金额轴启用但当月存在价格未知调用且
 *  无 token 预算兜底时，「金额口径低估」不再静默；消费方并入暂停/中止文案。 */
export type BudgetOverage = {
  parts: string[]
  action: 'pause' | 'abort'
  warnings: string[]
}

/** 预算护栏判定：金额（USD）+ token 双口径，返回超支描述 + 阻断动作（空 parts =
 *  无需阻断——可能超支但动作仅 warn）。
 *  金额口径受 budgetAction 控制；token 口径受 tokenBudgetAction 控制（缺省回退
 *  budgetAction，向后兼容）。warn 动作只走前端徽标/面板告警，不进本判定。
 *  供 Web loop 暂停/中止、CLI 拒绝、子 agent 提前中止共用。
 *  项目口径仅在 projectId 可归属时检查（未归属会话只受全局口径兜底）。
 *  token 口径独立于价格，兜底自建网关/未登记模型（cost 恒 $0）的场景。
 *  P1：金额/token 两轴动作各自求值，多轴同时超支取更严格者（abort > pause），
 *  不再被单一布尔预算标志坍缩降级。 */
export async function budgetOverageParts(
  handle: DB,
  usage: UsageConfig,
  projectId: string | null | undefined,
  now = new Date(),
): Promise<BudgetOverage> {
  const projectBudgetUsd = usage.monthlyBudgetUsd ?? 0
  const globalBudgetUsd = usage.globalMonthlyBudgetUsd ?? 0
  const projectTokenBudget = usage.monthlyTokenBudget ?? 0
  const globalTokenBudget = usage.globalMonthlyTokenBudget ?? 0
  const amountAction = usage.budgetAction ?? 'warn'
  const tokenAction = usage.tokenBudgetAction ?? amountAction
  // P0-3：'pause' 与 'abort' 都是阻断动作（均需 loop 放行前检查）；'warn' 不阻断。
  const amountBlocks = amountAction === 'pause' || amountAction === 'abort'
  const tokenBlocks = tokenAction === 'pause' || tokenAction === 'abort'
  const projectScoped = projectId != null && (projectBudgetUsd > 0 || projectTokenBudget > 0)
  const globalScoped = globalBudgetUsd > 0 || globalTokenBudget > 0
  if (!projectScoped && !globalScoped) return { parts: [], action: 'pause', warnings: [] }

  const [project, global] = await Promise.all([
    projectScoped ? currentMonthUsage(handle, projectId, now) : Promise.resolve(null),
    globalScoped ? currentMonthUsage(handle, undefined, now) : Promise.resolve(null),
  ])

  // P2-2：金额轴阻断启用但价格未知调用无 token 兜底 → 「金额口径低估」告警。
  // 仅当对应范围未设置 token 预算（token 兜底缺失）且当月确有 cost=null 调用时
  // 追加——warnings 不触发阻断，只并入暂停/中止文案让用户知道护栏口径不可靠。
  const warnings: string[] = []
  const amountAxisActive =
    amountBlocks && (globalBudgetUsd > 0 || (projectBudgetUsd > 0 && projectId != null))
  if (amountAxisActive) {
    const globalUnknown = global?.unknownCostCalls ?? 0
    if (globalBudgetUsd > 0 && globalTokenBudget <= 0 && globalUnknown > 0) {
      warnings.push(
        `金额口径低估：本月有 ${globalUnknown} 次调用价格未知（按 $0 计入），且未设置全局 token 预算兜底`,
      )
    }
    const projectUnknown = project?.unknownCostCalls ?? 0
    if (
      projectBudgetUsd > 0 &&
      projectTokenBudget <= 0 &&
      projectId != null &&
      projectUnknown > 0
    ) {
      warnings.push(
        `金额口径低估：本项目有 ${projectUnknown} 次调用价格未知（按 $0 计入），且未设置项目 token 预算兜底`,
      )
    }
  }

  const parts: string[] = []
  // 实际超支轴中的最严格阻断动作：任一超支轴动作 === 'abort' 即整体 abort，否则 pause。
  let action: 'pause' | 'abort' = 'pause'
  if (amountBlocks && globalBudgetUsd > 0 && global && global.cost > globalBudgetUsd) {
    parts.push(`全局预算 $${globalBudgetUsd.toFixed(2)}：本月全部项目已 $${global.cost.toFixed(2)}`)
    if (amountAction === 'abort') action = 'abort'
  }
  if (amountBlocks && projectBudgetUsd > 0 && project && project.cost > projectBudgetUsd) {
    parts.push(`项目预算 $${projectBudgetUsd.toFixed(2)}：本项目已 $${project.cost.toFixed(2)}`)
    if (amountAction === 'abort') action = 'abort'
  }
  if (tokenBlocks && globalTokenBudget > 0 && global && global.tokens > globalTokenBudget) {
    parts.push(
      `全局 token 预算 ${globalTokenBudget.toLocaleString()}：本月已 ${global.tokens.toLocaleString()} tokens`,
    )
    if (tokenAction === 'abort') action = 'abort'
  }
  if (tokenBlocks && projectTokenBudget > 0 && project && project.tokens > projectTokenBudget) {
    parts.push(
      `项目 token 预算 ${projectTokenBudget.toLocaleString()}：本项目已 ${project.tokens.toLocaleString()} tokens`,
    )
    if (tokenAction === 'abort') action = 'abort'
  }
  return { parts, action, warnings }
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
