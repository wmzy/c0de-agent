// src/server/routes/usage.ts
// 用量/成本聚合端点（P2 成本聚合视图）：汇总全部未删除会话的 LLM 调用用量与成本。
// 数据源：sessions.metadata.segments[].calls[]（每段带 provider/model，每 call 带
// usage/cost/timestamp）。成本为服务端按 provider 价目估算值（loop manageSegment
// 写入），与会话信息面板口径一致。
import { isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { sessions } from '../../db/schema.js'
import type { ServerContext } from '../types.js'

/** 单组用量汇总（totals / byMonth / byModel 共用结构）。 */
type UsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cost: number
  calls: number
}

type SegmentRecord = {
  provider?: string
  model?: string
  calls?: Array<{
    timestamp?: number
    usage?: { input?: number; output?: number; cacheRead?: number }
    cost?: number
  }>
}

const emptyTotals = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  cost: 0,
  calls: 0,
})

const add = (
  t: UsageTotals,
  input: number,
  output: number,
  cacheRead: number,
  cost: number,
): void => {
  t.inputTokens += input
  t.outputTokens += output
  t.cacheRead += cacheRead
  t.cost += cost
  t.calls += 1
}

function createUsageRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // GET /api/usage/summary — 总量 + 按月 + 按模型（会话级元数据聚合，零额外表）。
  app.get('/summary', async (c) => {
    const rows = await ctx.db.db
      .select({ id: sessions.id, metadata: sessions.metadata })
      .from(sessions)
      .where(isNull(sessions.deletedAt))

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
          const cost = typeof call.cost === 'number' ? call.cost : 0
          add(totals, input, output, cacheRead, cost)

          const month =
            typeof call.timestamp === 'number' && call.timestamp > 0
              ? new Date(call.timestamp).toISOString().slice(0, 7)
              : '未知'
          const m = byMonth.get(month) ?? emptyTotals()
          add(m, input, output, cacheRead, cost)
          byMonth.set(month, m)

          const mdl = byModel.get(modelLabel) ?? emptyTotals()
          add(mdl, input, output, cacheRead, cost)
          byModel.set(modelLabel, mdl)
        }
      }
    }

    return c.json({
      totals,
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
