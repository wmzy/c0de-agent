// src/server/routes/usage.ts
// 用量/成本聚合端点（P2 成本聚合视图）。数据源：usage_events 账本表——
// 与 session 生命周期解耦：会话物理清除（回收站到期宽限期满/彻底删除/临时会话
// 清理）不抹去已发生花费。cost=null 的调用（价格未知）按 $0 计入并单独计数
// （unknownCostCalls），前端据此提示预算可能低估。
// ?projectId= 过滤为「该项目口径」聚合：项目设置页的月度预算按本项目成本对比，
// 不再被其他项目的花费触发告警。月份键为本地时区 YYYY-MM（与服务端同机）。
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { usageEvents } from '../../db/schema.js'
import { PRICE_CATALOG_VERSION } from '../../llm/registry.js'
import { localMonthKey } from '../../session/usage.js'
import type { ServerContext } from '../types.js'

/** 单组用量汇总（totals / byMonth / byModel 共用结构）。 */
type UsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cost: number
  /** 价格未知、按 $0 计入的调用数（H2：显式提示低估，不再静默）。 */
  unknownCostCalls: number
  calls: number
}

const emptyTotals = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  cost: 0,
  unknownCostCalls: 0,
  calls: 0,
})

const add = (
  t: UsageTotals,
  input: number,
  output: number,
  cacheRead: number,
  cost: number,
  unknownCost: boolean,
): void => {
  t.inputTokens += input
  t.outputTokens += output
  t.cacheRead += cacheRead
  t.cost += cost
  if (unknownCost) t.unknownCostCalls += 1
  t.calls += 1
}

function createUsageRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // GET /api/usage/summary?projectId= — 总量 + 按月 + 按模型。
  // projectId 提供时仅聚合该项目的调用（项目设置页预算口径）；
  // 省略时全库聚合（含已删除项目产生的无归属调用）。
  app.get('/summary', async (c) => {
    const projectId = c.req.query('projectId')
    const rows = projectId
      ? await ctx.db.db.select().from(usageEvents).where(eq(usageEvents.projectId, projectId))
      : await ctx.db.db.select().from(usageEvents)

    const totals = emptyTotals()
    const byMonth = new Map<string, UsageTotals>()
    const byModel = new Map<string, UsageTotals>()

    for (const row of rows) {
      const modelLabel = `${row.provider ?? '未知'}/${row.model ?? '未知'}`
      const unknownCost = typeof row.cost !== 'number'
      const cost = typeof row.cost === 'number' ? row.cost : 0
      add(totals, row.inputTokens, row.outputTokens, row.cacheRead ?? 0, cost, unknownCost)

      const month = localMonthKey(row.timestamp)
      const m = byMonth.get(month) ?? emptyTotals()
      add(m, row.inputTokens, row.outputTokens, row.cacheRead ?? 0, cost, unknownCost)
      byMonth.set(month, m)

      const mdl = byModel.get(modelLabel) ?? emptyTotals()
      add(mdl, row.inputTokens, row.outputTokens, row.cacheRead ?? 0, cost, unknownCost)
      byModel.set(modelLabel, mdl)
    }

    return c.json({
      totals,
      // H3：价目版本随响应下发，前端标注估算可能过期。
      priceCatalogVersion: PRICE_CATALOG_VERSION,
      byMonth: [...byMonth.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .slice(0, 12)
        .map(([month, t]) => ({ month, ...t })),
      byModel: [...byModel.entries()]
        .sort((a, b) => b[1].cost - a[1].cost)
        .slice(0, 10)
        .map(([model, t]) => ({ model, ...t })),
    })
  })

  return app
}

export { createUsageRoute }
