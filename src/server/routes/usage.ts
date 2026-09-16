// src/server/routes/usage.ts
// 用量/成本聚合端点（P2 成本聚合视图）。数据源：usage_events 账本表——
// 与 session 生命周期解耦：会话物理清除（回收站到期宽限期满/彻底删除/临时会话
// 清理）不抹去已发生花费。cost=null 的调用（价格未知）按 $0 计入并单独计数
// （unknownCostCalls），前端据此提示预算可能低估。
// ?projectId= 过滤为「该项目口径」聚合：项目设置页的月度预算按本项目成本对比，
// 不再被其他项目的花费触发告警。月份键为本地时区 YYYY-MM（与服务端同机）。
import { eq, sql } from 'drizzle-orm'
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
  unknownCostCalls: number,
  calls: number,
): void => {
  t.inputTokens += input
  t.outputTokens += output
  t.cacheRead += cacheRead
  t.cost += cost
  t.unknownCostCalls += unknownCostCalls
  t.calls += calls
}

/** 服务端本地时区名（SQL 月份分组用；与 localMonthKey 的本地口径一致）。
 *  IANA 名在 PGLite 的 tzdata 中可用（已实证 Asia/Shanghai 等常见时区）；
 *  极端不可用时回退 UTC——分组可能跨月边界漂移，但聚合不再 O(全表)。 */
function serverTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function createUsageRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // GET /api/usage/summary?projectId= — 总量 + 按月 + 按模型。
  // projectId 提供时仅聚合该项目的调用（项目设置页预算口径）；
  // 省略时全库聚合（含已删除项目产生的无归属调用）。
  // P2 修复：此前全表 select 进内存手工聚合，usage_events 无界增长后每次
  // 打开用量面板 O(全部行) 内存与耗时。现在按（本地月份，provider, model,
  // projectId）SQL GROUP BY 聚合，结果行数 O(月份数 × 模型数)。
  app.get('/summary', async (c) => {
    const projectId = c.req.query('projectId')
    const where = projectId ? eq(usageEvents.projectId, projectId) : undefined
    // SQL 注入面：tz 名来自本机运行时（Intl），经字符白名单校验后以内联字面量
    // 拼接（白名单已排除单引号，无注入面）。必须内联而非参数占位——SELECT 与
    // GROUP BY 中各出现一次的参数化表达式被 PG 判定为不同表达式而拒绝 group by。
    const tz = serverTimeZone()
    if (!/^[A-Za-z0-9_+\-/]+$/.test(tz)) {
      const monthKey = localMonthKey(Date.now())
      return c.json({
        totals: emptyTotals(),
        byMonth: [],
        byModel: [],
        currentMonth: { key: monthKey, ...emptyTotals() },
      })
    }
    const monthExpr = sql<string>`to_char(to_timestamp(${usageEvents.timestamp} / 1000.0) AT TIME ZONE '${sql.raw(tz)}', 'YYYY-MM')`

    const rows = await ctx.db.db
      .select({
        month: monthExpr,
        provider: usageEvents.provider,
        model: usageEvents.model,
        projectId: usageEvents.projectId,
        input: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::float8`,
        output: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::float8`,
        cacheRead: sql<number>`coalesce(sum(${usageEvents.cacheRead}), 0)::float8`,
        cost: sql<number>`coalesce(sum(${usageEvents.cost}), 0)::float8`,
        calls: sql<number>`count(*)::int`,
        unknownCalls: sql<number>`count(*) filter (where ${usageEvents.cost} is null)::int`,
      })
      .from(usageEvents)
      .where(where ?? sql`true`)
      .groupBy(({ month, provider, model, projectId }) => [month, provider, model, projectId])

    const totals = emptyTotals()
    const byMonth = new Map<string, UsageTotals>()
    const byModel = new Map<string, UsageTotals>()
    // P1-3：未归属任何项目的调用（CLI 未绑定会话、孤儿会话）单独聚合——
    // 它们不计入任何项目预算，全局视图需明示这一桶。
    const unassigned = emptyTotals()

    for (const row of rows) {
      const modelLabel = `${row.provider ?? '未知'}/${row.model ?? '未知'}`
      // real（float4）列 SQL 求和引入浮点噪声（0.1 → 0.10000000149011612），
      // 金额口径按 6 位小数规整（USD 分以下精度足够，且与旧 JS 侧求和结果一致）。
      const cost = Math.round((row.cost ?? 0) * 1e6) / 1e6
      const input = row.input
      const output = row.output
      const cacheRead = row.cacheRead
      const unknownCalls = row.unknownCalls
      const calls = row.calls
      add(totals, input, output, cacheRead, cost, unknownCalls, calls)

      const m = byMonth.get(row.month) ?? emptyTotals()
      add(m, input, output, cacheRead, cost, unknownCalls, calls)
      byMonth.set(row.month, m)

      const mdl = byModel.get(modelLabel) ?? emptyTotals()
      add(mdl, input, output, cacheRead, cost, unknownCalls, calls)
      byModel.set(modelLabel, mdl)

      if (row.projectId === null) {
        add(unassigned, input, output, cacheRead, cost, unknownCalls, calls)
      }
    }

    // P1-4：本月口径由服务端本地时区计算并下发——此前前端用自己的时区
    // 过滤 byMonth 找「本月」，远程访问/容器时区不同时与预算暂停判定
    // （服务端 budgetOverageParts 同用本地时区口径）不一致，徽标显示未超支却被打断。
    const monthKey = localMonthKey(Date.now())
    const current = byMonth.get(monthKey) ?? emptyTotals()

    return c.json({
      totals,
      // H3：价目版本随响应下发，前端标注估算可能过期。
      priceCatalogVersion: PRICE_CATALOG_VERSION,
      // P1-4：服务端权威本月（key + 聚合），前端徽标/面板不再自行计算。
      currentMonth: { key: monthKey, ...current },
      // P1-3：仅全局视图下发（projectId 过滤时未归属桶与该项目无关）。
      ...(projectId ? {} : { unassigned }),
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
