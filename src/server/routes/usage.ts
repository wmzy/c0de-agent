// src/server/routes/usage.ts
// 用量/成本聚合端点（P2 成本聚合视图）：汇总全部会话（含回收站内软删除会话，
// H1：成本是账本不是快照——删除会话不应抹去已发生花费；物理清除后记录自然消失，
// 且已走「到期标记→宽限 7 天」两阶段流程）的 LLM 调用用量与成本。
// 数据源：sessions.metadata.segments[].calls[]（每段带 provider/model，每 call 带
// usage/cost/timestamp）。成本为服务端按 provider 价目估算值（loop manageSegment
// 写入），与会话信息面板口径一致。cost=null 的调用（价格未知，H2）按 $0 计入并
// 单独计数（unknownCostCalls），前端据此提示预算可能低估。
import { Hono } from 'hono'
import { sessions } from '../../db/schema.js'
import { PRICE_CATALOG_VERSION } from '../../llm/registry.js'
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

type SegmentRecord = {
  provider?: string
  model?: string
  calls?: Array<{
    timestamp?: number
    usage?: { input?: number; output?: number; cacheRead?: number }
    /** null = 价格未知（新数据）；缺失 = 旧数据，同样按未知计。 */
    cost?: number | null
  }>
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

  // GET /api/usage/summary — 总量 + 按月 + 按模型（会话级元数据聚合，零额外表）。
  app.get('/summary', async (c) => {
    // H1：不再过滤 deletedAt——软删除会话的已发生成本继续计入统计与预算告警。
    const rows = await ctx.db.db
      .select({ id: sessions.id, metadata: sessions.metadata })
      .from(sessions)

    const totals = emptyTotals()
    const byMonth = new Map<string, UsageTotals>()
    const byModel = new Map<string, UsageTotals>()

    for (const row of rows) {
      const meta = (row.metadata ?? {}) as { segments?: SegmentRecord[] }
      for (const seg of meta.segments ?? []) {
        const modelLabel = `${seg.provider ?? '未知'}/${seg.model ?? '未知'}`
        for (const call of seg.calls ?? []) {
          const input = typeof call.usage?.input === 'number' ? call.usage.input : 0
          const output = typeof call.usage?.output === 'number' ? call.usage.output : 0
          const cacheRead = typeof call.usage?.cacheRead === 'number' ? call.usage.cacheRead : 0
          // H2：cost 为 null/缺失 = 价格未知 → 按 $0 计入并计数（unknownCostCalls）。
          const cost = typeof call.cost === 'number' ? call.cost : 0
          const unknownCost = typeof call.cost !== 'number'
          add(totals, input, output, cacheRead, cost, unknownCost)

          const month =
            typeof call.timestamp === 'number' && call.timestamp > 0
              ? new Date(call.timestamp).toISOString().slice(0, 7)
              : '未知'
          const m = byMonth.get(month) ?? emptyTotals()
          add(m, input, output, cacheRead, cost, unknownCost)
          byMonth.set(month, m)

          const mdl = byModel.get(modelLabel) ?? emptyTotals()
          add(mdl, input, output, cacheRead, cost, unknownCost)
          byModel.set(modelLabel, mdl)
        }
      }
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
