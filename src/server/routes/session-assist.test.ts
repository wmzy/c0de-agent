// 交互辅助端点（assist.*，oh-my-pi 口径迁移）：POST /:id/predict-prompt 与
// GET /:id/recap。LLM 侧链路经 chatStream——这里 mock 掉 provider 层，锁定端点
// 行为：开关守卫、settled 守卫、回复清洗、recap 幂等缓存（metadata.lastRecap）。
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '../../db/client.js'
import { projects } from '../../db/schema.js'
import { createTestDB, resetTestDB } from '../../db/test-utils.js'
import { createRegistry } from '../../llm/registry.js'
import { appendMessage } from '../../session/message.js'
import { createSession, getSession, updateSessionLastRun } from '../../session/session.js'
import type { StreamChunk } from '../../shared/types/llm.js'
import { createServerContext } from '../context.js'
import { createSessionRoute } from './session.js'

/** 产出一段纯文本 chunk 的流（chatStream 的最小替身）。 */
function textStream(text: string) {
  return (async function* (): AsyncGenerator<StreamChunk> {
    yield { _tag: 'text', text }
  })()
}

// chatStream mock：默认返回一段固定文本，各用例按需覆盖（NO_PREDICTION、引号
// 包裹等清洗分支在 core/assist.test.ts 锁定，这里只走端点行为）。
const chatStreamMock = vi.fn<() => AsyncGenerator<StreamChunk>>(() => textStream('继续'))
vi.mock('../../llm/provider.js', async (importOriginal) => {
  const actual = (await importOriginal<typeof import('../../llm/provider.js')>()) as Record<
    string,
    unknown
  >
  return {
    ...actual,
    chatStream: (...args: unknown[]) => chatStreamMock(...(args as [])),
  }
})

let dbHandle: DB
beforeAll(async () => {
  dbHandle = await createTestDB()
})
afterAll(async () => {
  await dbHandle.close()
})
afterEach(async () => {
  await resetTestDB(dbHandle)
  chatStreamMock.mockImplementation(() => textStream('继续'))
})

const TEST_PROJECT = 'assist-test-project'

async function setup(opts?: { assist?: { predictionEnabled?: boolean; recapEnabled?: boolean } }) {
  const db = dbHandle
  await db.db.insert(projects).values({ id: TEST_PROJECT, worktree: '/tmp/assist-test' })
  const ctx = createServerContext({
    db,
    llmRegistry: createRegistry(),
    config: {
      assist: {
        predictionEnabled: opts?.assist?.predictionEnabled ?? true,
        recapEnabled: opts?.assist?.recapEnabled ?? true,
        recapIdleSeconds: 240,
      },
    } as never,
  })
  const app = createSessionRoute(ctx)
  const session = await createSession(db, 'assist', TEST_PROJECT)
  return { app, ctx, db, session }
}

/** 追加一条 user 消息（appendMessage 是消息落库的既有入口）。 */
async function addUserMessage(db: DB, sessionId: string, text: string) {
  return appendMessage(db, sessionId, {
    role: 'user',
    content: [{ _tag: 'text', text }],
  })
}

describe('assist 端点：POST /:id/predict-prompt', () => {
  it('开关关闭 → 404（端点整体不可见）', async () => {
    const { app, session } = await setup({ assist: { predictionEnabled: false } })
    await addUserMessage(dbHandle, session.id, '帮我修个 bug')
    const res = await app.request(`/${session.id}/predict-prompt`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('空会话 → 409（无上下文可预测）', async () => {
    const { app, session } = await setup()
    const res = await app.request(`/${session.id}/predict-prompt`, { method: 'POST' })
    expect(res.status).toBe(409)
  })

  it('lastRun=running → 409（运行中的会话没有下一步）', async () => {
    const { app, ctx, session } = await setup()
    await addUserMessage(dbHandle, session.id, '帮我修个 bug')
    await updateSessionLastRun(ctx.db, session.id, { status: 'running' } as never)
    const res = await app.request(`/${session.id}/predict-prompt`, { method: 'POST' })
    expect(res.status).toBe(409)
  })

  it('settled 会话 → 走一次 side-turn 并返回清洗后的预测', async () => {
    const { app, session } = await setup()
    await addUserMessage(dbHandle, session.id, '帮我修个 bug')
    chatStreamMock.mockImplementation(() => textStream('“继续修”'))
    const res = await app.request(`/${session.id}/predict-prompt`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { prediction: string | null }
    // 引号包裹被剥掉（sanitizePrediction）
    expect(body.prediction).toBe('继续修')
    // prompt 里带着对话视图与「无把握回 NO_PREDICTION」指令
    const request = (chatStreamMock.mock.calls[0] as unknown[])[1] as {
      messages: { content: string }[]
    }
    expect(request.messages[0]?.content).toContain('帮我修个 bug')
    expect(request.messages[0]?.content).toContain('NO_PREDICTION')
  })

  it('side-turn 抛错 → 静默 200 prediction:null（ghost 是纯增强）', async () => {
    const { app, session } = await setup()
    await addUserMessage(dbHandle, session.id, '帮我修个 bug')
    chatStreamMock.mockImplementation(() => {
      throw new Error('provider down')
    })
    const res = await app.request(`/${session.id}/predict-prompt`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { prediction: string | null }
    expect(body.prediction).toBeNull()
  })
})

describe('assist 端点：GET /:id/recap', () => {
  it('开关关闭 → 404', async () => {
    const { app, session } = await setup({ assist: { recapEnabled: false } })
    await addUserMessage(dbHandle, session.id, '帮我修个 bug')
    const res = await app.request(`/${session.id}/recap`)
    expect(res.status).toBe(404)
  })

  it('首次生成 → 落 lastRecap 缓存；同锚点重复请求命中缓存不再调 LLM', async () => {
    const { app, ctx, session } = await setup()
    await addUserMessage(dbHandle, session.id, '帮我修个 bug')
    chatStreamMock.mockImplementation(() => textStream('目标是修 bug，下一步跑测试'))
    const first = await app.request(`/${session.id}/recap`)
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { recap: string | null; cached: boolean }
    expect(firstBody.cached).toBe(false)
    expect(firstBody.recap).toBe('目标是修 bug，下一步跑测试')

    // 缓存写入 metadata
    const stored = await getSession(ctx.db, session.id)
    expect(stored?.metadata.lastRecap?.text).toBe('目标是修 bug，下一步跑测试')

    const callsAfterFirst = chatStreamMock.mock.calls.length
    const second = await app.request(`/${session.id}/recap`)
    const secondBody = (await second.json()) as { recap: string | null; cached: boolean }
    expect(secondBody.cached).toBe(true)
    expect(chatStreamMock.mock.calls.length).toBe(callsAfterFirst)
  })

  it('新消息落地后锚点失效 → 重新生成', async () => {
    const { app, session } = await setup()
    await addUserMessage(dbHandle, session.id, '第一条')
    chatStreamMock.mockImplementation(() => textStream('回顾一'))
    await app.request(`/${session.id}/recap`)
    await addUserMessage(dbHandle, session.id, '第二条')
    chatStreamMock.mockImplementation(() => textStream('回顾二'))
    const res = await app.request(`/${session.id}/recap`)
    const body = (await res.json()) as { recap: string | null; cached: boolean }
    expect(body.cached).toBe(false)
    expect(body.recap).toBe('回顾二')
  })
})
