import { afterEach, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { sessions } from '../../db/schema.js'
import { createRegistry } from '../../llm/registry.js'
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

/** 构造一个带 LLM 调用记录的会话（metadata.segments[].calls[]）。 */
async function seedSession(
  db: DB,
  opts: {
    deleted: boolean
    calls: Array<{ input: number; output: number; cost: number | null; timestamp?: number }>
  },
): Promise<string> {
  const now = Date.now()
  const [row] = await db.db
    .insert(sessions)
    .values({
      title: 'seed',
      deletedAt: opts.deleted ? new Date() : null,
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
            calls: opts.calls.map((c, i) => ({
              id: `c${i}`,
              timestamp: c.timestamp ?? now,
              usage: { input: c.input, output: c.output },
              latency: { firstToken: 1, total: 1 },
              cost: c.cost,
              responseText: 'r',
            })),
          },
        ],
      },
    })
    .returning({ id: sessions.id })
  if (!row) throw new Error('seed failed')
  return row.id
}

describe('usage route', () => {
  it('H1：软删除会话的用量仍计入聚合（成本是账本，删除不抹账）', async () => {
    const { app, db } = await setup()
    await seedSession(db, {
      deleted: false,
      calls: [{ input: 1000, output: 200, cost: 0.5 }],
    })
    await seedSession(db, {
      deleted: true,
      calls: [{ input: 2000, output: 100, cost: 0.25 }],
    })
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
    await seedSession(db, {
      deleted: false,
      calls: [
        { input: 1000, output: 0, cost: 0.1 },
        { input: 500, output: 0, cost: null },
        { input: 250, output: 0, cost: null },
      ],
    })
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

  it('H2：cost 缺失（旧数据）同样计为未知', async () => {
    const { app, db } = await setup()
    const [row] = await db.db
      .insert(sessions)
      .values({
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
              startedAt: Date.now(),
              trigger: 'initial',
              calls: [
                {
                  id: 'c0',
                  timestamp: Date.now(),
                  usage: { input: 10, output: 0 },
                  latency: { firstToken: 1, total: 1 },
                  responseText: 'r',
                },
              ],
            },
          ],
        },
      })
      .returning({ id: sessions.id })
    expect(row).toBeTruthy()
    const res = await app.request('/summary')
    const body = (await res.json()) as { totals: { unknownCostCalls: number; calls: number } }
    expect(body.totals).toMatchObject({ unknownCostCalls: 1, calls: 1 })
  })
})
