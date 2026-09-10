import { afterEach, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { sessions, usageEvents } from '../../db/schema.js'
import { createRegistry } from '../../llm/registry.js'
import { backfillUsageEvents, backfillUsageEventsOnce } from '../../session/usage.js'
import { createServerContext } from '../context.js'
import { createUsageRoute } from './usage.js'

let dbHandle: DB | undefined

afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
})

async function setup() {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  const ctx = createServerContext({ db, llmRegistry: createRegistry() })
  const app = createUsageRoute(ctx)
  return { app, db }
}

/** 直接向 usage_events 账本表写入调用记录（写路径单元已在 manageSegment 覆盖）。 */
async function seedEvent(
  db: DB,
  opts: {
    projectId?: string
    input: number
    output: number
    cost: number | null
    timestamp?: number
  },
): Promise<void> {
  await db.db.insert(usageEvents).values({
    callId: crypto.randomUUID(),
    projectId: opts.projectId ?? null,
    provider: 'p',
    model: 'm',
    inputTokens: opts.input,
    outputTokens: opts.output,
    cacheRead: 0,
    cost: opts.cost,
    timestamp: opts.timestamp ?? Date.now(),
  })
}

describe('usage route', () => {
  it('聚合 usage_events 账本（含无归属调用）', async () => {
    const { app, db } = await setup()
    await seedEvent(db, { projectId: 'A', input: 1000, output: 200, cost: 0.5 })
    await seedEvent(db, { input: 2000, output: 100, cost: 0.25 })
    const res = await app.request('/summary')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      totals: { inputTokens: number; outputTokens: number; cost: number; calls: number }
    }
    expect(body.totals).toMatchObject({
      inputTokens: 3000,
      outputTokens: 300,
      cost: 0.75,
      calls: 2,
    })
  })

  it('H2：cost=null 的调用按 $0 计入并计数 unknownCostCalls', async () => {
    const { app, db } = await setup()
    await seedEvent(db, { input: 1000, output: 0, cost: 0.1 })
    await seedEvent(db, { input: 500, output: 0, cost: null })
    await seedEvent(db, { input: 250, output: 0, cost: null })
    const res = await app.request('/summary')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      totals: { cost: number; unknownCostCalls: number; calls: number }
      priceCatalogVersion: string
    }
    expect(body.totals).toMatchObject({ cost: 0.1, unknownCostCalls: 2, calls: 3 })
    // H3：价目版本随响应下发
    expect(typeof body.priceCatalogVersion).toBe('string')
    expect(body.priceCatalogVersion.length).toBeGreaterThan(0)
  })

  it('P1：?projectId= 仅聚合该项目（项目设置页预算口径）', async () => {
    const { app, db } = await setup()
    await seedEvent(db, { projectId: 'A', input: 1000, output: 0, cost: 1 })
    await seedEvent(db, { projectId: 'B', input: 500, output: 0, cost: 2 })
    await seedEvent(db, { input: 250, output: 0, cost: 4 })
    const res = await app.request('/summary?projectId=A')
    const body = (await res.json()) as { totals: { cost: number; calls: number } }
    expect(body.totals).toMatchObject({ cost: 1, calls: 1 })
  })

  it('P1-4：currentMonth 由服务端下发（key + 聚合）', async () => {
    const { app, db } = await setup()
    await seedEvent(db, { projectId: 'A', input: 1000, output: 0, cost: 1 })
    // 上月事件不进入本月口径
    const lastMonth = new Date()
    lastMonth.setMonth(lastMonth.getMonth() - 1)
    await seedEvent(db, {
      projectId: 'A',
      input: 500,
      output: 0,
      cost: 9,
      timestamp: lastMonth.getTime(),
    })
    const res = await app.request('/summary?projectId=A')
    const body = (await res.json()) as {
      currentMonth: { key: string; cost: number; calls: number }
    }
    expect(typeof body.currentMonth.key).toBe('string')
    expect(body.currentMonth).toMatchObject({ cost: 1, calls: 1 })
  })

  it('P1-3：全局视图下发 unassigned 桶（未归属调用不计入任何项目预算）', async () => {
    const { app, db } = await setup()
    await seedEvent(db, { projectId: 'A', input: 1000, output: 0, cost: 1 })
    await seedEvent(db, { input: 2000, output: 0, cost: 4 })
    const res = await app.request('/summary')
    const body = (await res.json()) as {
      unassigned: { cost: number; calls: number }
    }
    expect(body.unassigned).toMatchObject({ cost: 4, calls: 1 })
    // 项目口径不携带 unassigned（与该项目无关）
    const proj = await app.request('/summary?projectId=A')
    const projBody = (await proj.json()) as { unassigned?: unknown }
    expect(projBody.unassigned).toBeUndefined()
  })

  it('backfill 幂等：重复执行不重复记账（callId 唯一约束）', async () => {
    const { app, db } = await setup()
    // 模拟升级前旧数据：sessions.metadata.segments 含两条调用
    const now = Date.now()
    await db.db.insert(sessions).values({
      title: 'legacy',
      metadata: {
        segments: [
          {
            id: 'seg',
            fingerprint: 'fp',
            provider: 'p',
            model: 'm',
            systemPrompt: 'sys',
            tools: [],
            startedAt: now,
            trigger: 'initial',
            calls: [
              {
                id: crypto.randomUUID(),
                timestamp: now,
                usage: { input: 10, output: 0 },
                latency: { firstToken: 1, total: 1 },
                cost: 0.5,
                responseText: 'r',
              },
              {
                id: crypto.randomUUID(),
                timestamp: now,
                usage: { input: 20, output: 0 },
                latency: { firstToken: 1, total: 1 },
                responseText: 'r',
              },
            ],
          },
        ],
      },
    })
    const first = await backfillUsageEvents(db)
    expect(first).toBe(2)
    const second = await backfillUsageEvents(db)
    expect(second).toBe(0)

    const res = await app.request('/summary')
    const body = (await res.json()) as {
      totals: { inputTokens: number; unknownCostCalls: number; calls: number }
    }
    expect(body.totals).toMatchObject({ inputTokens: 30, unknownCostCalls: 1, calls: 2 })
  })

  it('backfill 容忍无 segments 的会话', async () => {
    const { db } = await setup()
    await db.db.insert(sessions).values({ title: 'plain' })
    await expect(backfillUsageEvents(db)).resolves.toBe(0)
  })

  it('P3-8：backfillUsageEventsOnce 首次执行后写标记，再次调用跳过扫描', async () => {
    const { db } = await setup()
    const now = Date.now()
    await db.db.insert(sessions).values({
      title: 'legacy-once',
      metadata: {
        segments: [
          {
            provider: 'p',
            model: 'm',
            calls: [
              {
                id: crypto.randomUUID(),
                timestamp: now,
                usage: { input: 10, output: 0 },
                cost: 0.5,
              },
            ],
          },
        ],
      },
    })
    const first = await backfillUsageEventsOnce(db)
    expect(first).toBe(1)
    // 二次调用不重复记账、不再扫描
    const second = await backfillUsageEventsOnce(db)
    expect(second).toBe(0)
    // 新增带 call id 的会话也不会被 once 变体重复 backfill（迁移语义：仅升级首启一次）
    await db.db.insert(sessions).values({
      title: 'post-migration',
      metadata: {
        segments: [
          {
            provider: 'p',
            model: 'm',
            calls: [
              {
                id: crypto.randomUUID(),
                timestamp: now,
                usage: { input: 5, output: 0 },
                cost: 0.1,
              },
            ],
          },
        ],
      },
    })
    await expect(backfillUsageEventsOnce(db)).resolves.toBe(0)
    const rows = await db.db.select().from(usageEvents)
    expect(rows).toHaveLength(1)
  })
})
