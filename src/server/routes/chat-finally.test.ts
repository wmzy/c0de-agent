import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import { createSession } from '../../session/session.js'
import type { StreamChunk } from '../../shared/types/llm.js'
import { createServerContext } from '../context.js'
import { createChatRoute } from './chat.js'

// 单独成文件的原因：本文件用 vi.mock 替换 hono/streaming 的 streamSSE，注入一个
// writeSSE 会 reject 的假 stream（模拟客户端断开）。若放进 chat.test.ts 会破坏其中
// 依赖真实 SSE 缓冲的 ~20 个用例。此处驱动 chat.ts 真实的 finally 逻辑（非重构提取），
// 断言 unregister 在 writeSSE reject 时仍被调用。

// vi.hoisted 保证工厂内引用在 vi.mock 提升后仍可用。
const mocks = vi.hoisted(() => ({
  writeSSE: vi.fn(async (_input: unknown) => {}),
}))

vi.mock('hono/streaming', () => ({
  streamSSE: async (
    _c: unknown,
    handler: (stream: {
      onAbort(cb: () => void): void
      writeSSE(input: unknown): Promise<void>
    }) => Promise<void>,
  ) => {
    const stream = { onAbort() {}, writeSSE: mocks.writeSSE }
    try {
      await handler(stream)
    } catch {
      // writeSSE reject 经 catch 块向上传播；finally 已在此前执行完毕。
    }
    return new Response('ok', { status: 200 })
  },
}))

function mockChatStream(): AsyncGenerator<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    yield { _tag: 'text', text: 'Hello' }
    yield { _tag: 'done' }
  })()
}

let dbHandle: DB | undefined
afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
  mocks.writeSSE.mockReset()
  mocks.writeSSE.mockResolvedValue(undefined)
})

async function setup() {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  const session = await createSession(db, 'Test')
  const ctx = createServerContext({ db, llmRegistry: createRegistry(), chatStream: mockChatStream })
  const app = createChatRoute(ctx)
  return { app, ctx, sessionId: session.id }
}

describe('chat route finally — unregister 在 writeSSE reject 时仍执行', () => {
  it('客户端断开（writeSSE reject）时 agentManager.unregister 仍被调用且 run 已清除', async () => {
    // 模拟客户端断开：writeSSE 全部 reject。
    mocks.writeSSE.mockRejectedValue(new Error('client disconnected'))

    const { app, ctx, sessionId } = await setup()
    const unregisterSpy = vi.spyOn(ctx.agentManager, 'unregister')

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'Hello' }),
    })
    expect(res.status).toBe(200)

    // unregister 必须执行（修复前会被 finally 中首个 writeSSE reject 跳过）。
    expect(unregisterSpy).toHaveBeenCalledTimes(1)
    expect(ctx.agentManager.get(sessionId)).toBeUndefined()
  })

  it('正常完成（writeSSE 不 reject）时 unregister 恰好调用一次', async () => {
    // writeSSE 正常 resolve（默认）。
    mocks.writeSSE.mockResolvedValue(undefined)

    const { app, ctx, sessionId } = await setup()
    const unregisterSpy = vi.spyOn(ctx.agentManager, 'unregister')

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'Hello' }),
    })
    expect(res.status).toBe(200)

    expect(unregisterSpy).toHaveBeenCalledTimes(1)
    expect(ctx.agentManager.get(sessionId)).toBeUndefined()
  })
})
