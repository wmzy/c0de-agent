import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { SSEStreamingApi } from 'hono/streaming'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../core/config.js'
import type { WorkflowEntry } from '../../core/workflows/types.js'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { sessions } from '../../db/schema.js'
import { createRegistry } from '../../llm/registry.js'
import { fromDirectory, trustProject } from '../../project/project.js'
import { appendMessage, getEntries } from '../../session/message.js'
import {
  createSession,
  getLLMSegments,
  getSession,
  listAllSessions,
} from '../../session/session.js'
import { getFileSnapshots } from '../../session/snapshot.js'
import type { StreamChunk } from '../../shared/types/llm.js'
import { createServerContext } from '../context.js'
import {
  createChatRoute,
  resolveAgentCwd,
  SSE_HEARTBEAT_INTERVAL_MS,
  startHeartbeat,
} from './chat.js'
import { createCommandsRoute } from './commands.js'

/** 模拟 chatStream：返回简单的文本 + done。 */
function mockChatStream(): AsyncGenerator<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    yield { _tag: 'text', text: 'Hello' }
    yield { _tag: 'text', text: ' world' }
    yield { _tag: 'done' }
  })()
}

let dbHandle: DB | undefined
afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
})

async function setup(opts: { cwd?: string } = {}) {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  const session = await createSession(db, 'Test')
  const ctx = createServerContext({
    db,
    llmRegistry: createRegistry(),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    chatStream: mockChatStream,
  })
  const app = createChatRoute(ctx)
  return { app, ctx, sessionId: session.id }
}

/** 从 SSE 响应中解析事件。 */
function parseSSEEvents(text: string): { event: string; data: string }[] {
  const events: { event: string; data: string }[] = []
  const blocks = text.split('\n\n')
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim())
    if (lines.length === 0) continue
    const eventLine = lines.find((l) => l.startsWith('event:'))
    const dataLine = lines.find((l) => l.startsWith('data:'))
    if (eventLine && dataLine) {
      events.push({
        event: eventLine.slice(6).trim(),
        data: dataLine.slice(5).trim(),
      })
    }
  }
  return events
}

describe('chat route (SSE)', () => {
  it('POST / without sessionId returns 400', async () => {
    const { app } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST / without message returns 400', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    expect(res.status).toBe(400)
  })

  it('POST / nonexistent session returns 404', async () => {
    const { app } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nonexistent', message: 'hi' }),
    })
    expect(res.status).toBe(404)
  })

  it('P2：POST / 拒绝回收站会话（与删除心智模型对齐，不再向软删除会话写消息）', async () => {
    const { app, ctx, sessionId } = await setup()
    const session = await getSession(ctx.db, sessionId)
    if (!session) throw new Error('session missing')
    await ctx.db.db
      .update(sessions)
      .set({ deletedAt: new Date() })
      .where(eq(sessions.id, sessionId))
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'hi' }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('NOT_FOUND')
  })

  it('POST / streams agent events', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'Hello' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const text = await res.text()
    const events = parseSSEEvents(text)

    const types = events.map((e) => e.event)
    expect(types).toContain('text_delta')
    expect(types).toContain('done')
  })

  it('POST / 带 body.agent=plan 使用只读工具集', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'test', agent: 'plan' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    const events = parseSSEEvents(text)
    expect(events.some((e) => e.event === 'done')).toBe(true)
  })

  it('POST / 带 body.agent=unknown 返回 400', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'test', agent: 'nonexistent' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST / 带 body.agent=general（subagent）返回 400', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'test', agent: 'general' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST / 带 body.agents 注入 subagent 指令前缀', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        message: '帮我实现 X',
        agents: ['coder'],
      }),
    })
    expect(res.status).toBe(200)
    // mockChatStream 不暴露 message，但 200 + done 表示注入未报错
    const text = await res.text()
    const events = parseSSEEvents(text)
    expect(events.some((e) => e.event === 'done')).toBe(true)
  })

  it('POST / 带 body.agents 全部无效 → 400（此前静默忽略）', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'hi', agents: ['nope', 'default'] }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_AGENT_MENTION')
  })

  it('POST / text_delta events contain text content', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'Hi' }),
    })
    const text = await res.text()
    const events = parseSSEEvents(text)
    const textDeltas = events.filter((e) => e.event === 'text_delta')
    const combinedText = textDeltas.map((e) => JSON.parse(e.data).text as string).join('')
    expect(combinedText).toContain('Hello')
  })

  it('POST / unregisters from agentManager after completion', async () => {
    const { app, ctx, sessionId } = await setup()
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'Hi' }),
    })
    expect(ctx.agentManager.get(sessionId)).toBeUndefined()
  })

  it('POST / 模型变更且未确认 → 409 SEGMENT_BREAK_REQUIRED（含 activeSegment）', async () => {
    const { app, sessionId } = await setup()
    // 第一条消息建立首段（默认模型）
    const first = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'hi' }),
    })
    expect(first.status).toBe(200)
    await first.text() // 消费流，驱动 saveLLMSegments

    // 第二条消息切换模型、不带 confirmSegmentBreak → 409
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'more', model: 'other-model' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      error: { code: string; details?: { activeSegment?: { model?: string } } }
    }
    expect(body.error.code).toBe('SEGMENT_BREAK_REQUIRED')
    expect(body.error.details?.activeSegment?.model).toBeTruthy()
  })

  it('POST / 会话已有活跃 run → 409 RUN_ACTIVE', async () => {
    const { app, ctx, sessionId } = await setup()
    // 模拟进行中的 run（伪造最小 state/deps 直接占位 agentManager）
    ctx.agentManager.register({
      sessionId,
      state: {} as never,
      deps: {} as never,
    })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'second concurrent' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RUN_ACTIVE')
  })

  it('POST / 活跃 run 期间变更型斜杠命令（/clear）→ 409 RUN_ACTIVE（P3 竞态守卫）', async () => {
    const { app, ctx, sessionId } = await setup()
    ctx.agentManager.register({ sessionId, state: {} as never, deps: {} as never })
    for (const cmd of ['/clear --yes', '/compact', '/fork']) {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: cmd }),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('RUN_ACTIVE')
    }
  })

  // P0-4 竞态回归：旧实现守卫用 get 检查、真正 register 在 SSE 回调内，中间隔
  // 多个 await，双发 POST 均通过守卫后后注册覆盖前者（runs.set），且 A 结束时
  // unregister 误删仍在跑的 B。现守卫为同步原子占位 tryAcquire。
  it('POST / 同 sessionId 连发两次：第一个占住后第二个必 409 RUN_ACTIVE', async () => {
    const { app, ctx, sessionId } = await setup()
    // 第一个请求：handler 返回 SSE Response 前已同步完成占位（流未消费、
    // register 未执行即可被第二个请求观测到）
    const first = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'first' }),
    })
    expect(first.status).toBe(200)

    // 第二个请求在第一个 run 仍在进行（流未消费）时到达 → 409，不得开第二股流
    const second = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'second' }),
    })
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RUN_ACTIVE')

    // 消费第一个流至结束：占位/run 释放，会话不被锁死，可再次对话
    await first.text()
    expect(ctx.agentManager.get(sessionId)).toBeUndefined()
    const third = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'third' }),
    })
    expect(third.status).toBe(200)
    await third.text()
  })

  it('POST / 守卫后提前返回（INVALID_AGENT）时释放占位，会话不被锁死', async () => {
    const { app, ctx, sessionId } = await setup()
    const bad = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'x', agent: 'nonexistent' }),
    })
    expect(bad.status).toBe(400)
    expect(ctx.agentManager.isStarting(sessionId)).toBe(false)
    expect(ctx.agentManager.get(sessionId)).toBeUndefined()

    // 紧随其后的正常请求可成功（占位未泄漏）
    const ok = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'hi' }),
    })
    expect(ok.status).toBe(200)
    await ok.text()
  })

  it('POST / SEGMENT_BREAK_REQUIRED 409 时同样释放占位', async () => {
    const { app, ctx, sessionId } = await setup()
    // 第一条消息建立首段
    const first = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'hi' }),
    })
    await first.text()

    // 换模型不带确认 → 占位后提前 409 返回
    const brk = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'more', model: 'other-model' }),
    })
    expect(brk.status).toBe(409)
    expect(ctx.agentManager.isStarting(sessionId)).toBe(false)

    // 占位已释放：原模型继续对话不受影响
    const again = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'again' }),
    })
    expect(again.status).toBe(200)
    await again.text()
  })

  it('POST / 模型变更且带 confirmSegmentBreak → 200 开新段', async () => {
    const { app, ctx, sessionId } = await setup()
    const first = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'hi' }),
    })
    await first.text()

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        message: 'more',
        model: 'other-model',
        confirmSegmentBreak: true,
      }),
    })
    expect(res.status).toBe(200)
    await res.text()
    const segs = await getLLMSegments(ctx.db, sessionId)
    expect(segs).toHaveLength(2)
    expect(segs[1]?.model).toBe('other-model')
    expect(segs[1]?.trigger).toBe('model_change')
  })

  // Web 前端 ToolToggle 全选（不带 tools 字段）时，后端回退 config.tools.enabled 默认集。
  // 默认集为 ['*']（通配 = 全部注册工具）；显式空数组才是「无工具」（fail-closed）。
  it('POST / 不带 tools 时启用全部注册工具（默认 enabled:["*"]）', async () => {
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const session = await createSession(db, 'Test')
    const ctx = createServerContext({
      db,
      llmRegistry: createRegistry(),
      config: { ...DEFAULT_CONFIG, tools: { enabled: ['*'], disabled: [] } },
      chatStream: mockChatStream,
    })
    const app = createChatRoute(ctx)

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 不带 tools 字段，模拟前端 ToolToggle 全选状态
      body: JSON.stringify({ sessionId: session.id, message: 'hi' }),
    })
    expect(res.status).toBe(200)
    // 消费完整 SSE 流，驱动 agentLoop 执行到 saveLLMSegments
    await res.text()

    // loop 持久化的 segment.tools 即发送给 LLM 的工具定义；不带 tools 时启用全部注册工具
    const segments = await getLLMSegments(db, session.id)
    expect(segments).toHaveLength(1)
    const toolNames = segments[0]?.tools.map((t) => t.name).sort()
    expect(toolNames).toEqual([
      'bash',
      'debug_breakpoint',
      'debug_continue',
      'debug_eval',
      'debug_stack',
      'debug_start',
      'debug_step',
      'debug_stop',
      'debug_vars',
      'edit',
      'glob',
      'grep',
      'kanban',
      'read',
      'task',
      'todo',
      'websearch',
      'write',
      'yield',
    ])
  })

  it('POST / config.tools.disabled 工具不进入 LLM 工具集', async () => {
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const session = await createSession(db, 'Test')
    const ctx = createServerContext({
      db,
      llmRegistry: createRegistry(),
      config: { ...DEFAULT_CONFIG, tools: { enabled: ['*'], disabled: ['bash', 'grep'] } },
      chatStream: mockChatStream,
    })
    const app = createChatRoute(ctx)

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, message: 'hi' }),
    })
    expect(res.status).toBe(200)
    await res.text()

    const segments = await getLLMSegments(db, session.id)
    const toolNames = segments[0]?.tools.map((t) => t.name).sort()
    expect(toolNames).not.toContain('bash')
    expect(toolNames).not.toContain('grep')
    expect(toolNames).toContain('read')
  })

  // 回归：catch 块必须发送 done 事件，否则前端 isStreaming 永远不会变 false。
  // 此前 catch 块只发 error 不发 done，依赖前端 gotError 回退——
  // 若 error 事件也因流关闭而丢失，前端会永远卡在 streaming 态。
  it('POST / chatStream 抛错时 SSE 流仍以 done 结束', async () => {
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const session = await createSession(db, 'Test')
    const throwingStream = (): AsyncGenerator<StreamChunk> =>
      (async function* (): AsyncGenerator<StreamChunk> {
        yield { _tag: 'text', text: 'partial' }
        throw new Error('stream blew up')
      })()
    const ctx = createServerContext({
      db,
      llmRegistry: createRegistry(),
      chatStream: throwingStream,
    })
    const app = createChatRoute(ctx)

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, message: 'hi' }),
    })
    expect(res.status).toBe(200)
    const events = parseSSEEvents(await res.text())
    const types = events.map((e) => e.event)
    // error 事件应被发送
    expect(types).toContain('error')
    // done 事件必须在 error 之后发送（catch 块补发）
    expect(types).toContain('done')
    const errorIdx = types.indexOf('error')
    const doneIdx = types.indexOf('done')
    expect(doneIdx).toBeGreaterThan(errorIdx)
  })

  it('resolveAgentCwd: returns worktree when session has project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwd-'))
    try {
      const db = await createDB({ driver: 'pglite' })
      dbHandle = db
      await migrateDB(db)
      const project = await fromDirectory(db, dir)
      const ctx = createServerContext({
        db,
        llmRegistry: createRegistry(),
        chatStream: mockChatStream,
      })
      const cwd = await resolveAgentCwd(ctx, { projectId: project.id })
      expect(cwd).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolveAgentCwd: falls back to ctx.cwd when no project', async () => {
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    const ctx = createServerContext({
      db,
      llmRegistry: createRegistry(),
      chatStream: mockChatStream,
      cwd: '/some/base',
    })
    const cwd = await resolveAgentCwd(ctx, { projectId: null })
    expect(cwd).toBe('/some/base')
  })

  it('resolveAgentCwd: 无项目但有 worktreePath → 用 worktreePath（项目删除后恢复的会话）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwd-wt-'))
    try {
      const db = await createDB({ driver: 'pglite' })
      dbHandle = db
      await migrateDB(db)
      const ctx = createServerContext({
        db,
        llmRegistry: createRegistry(),
        chatStream: mockChatStream,
        cwd: '/some/base',
      })
      const cwd = await resolveAgentCwd(ctx, { projectId: null, worktreePath: dir })
      expect(cwd).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolveAgentCwd: worktreePath 失效 → 抛 WORKTREE_MISSING 而非静默回退 serve cwd', async () => {
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    const ctx = createServerContext({
      db,
      llmRegistry: createRegistry(),
      chatStream: mockChatStream,
      cwd: '/some/base',
    })
    await expect(
      resolveAgentCwd(ctx, { projectId: null, worktreePath: '/nonexistent/deleted-dir' }),
    ).rejects.toThrow(/WORKTREE_MISSING/)
  })

  // 斜杠命令拦截（spec §3.8）：/help 等命令在服务端执行，返回结果文本而非启动 agent
  it('/help 命令返回命令列表文本，不启动 agent', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '/help' }),
    })
    expect(res.status).toBe(200)
    const events = parseSSEEvents(await res.text())
    const types = events.map((e) => e.event)
    expect(types).toContain('text_delta')
    expect(types).toContain('done')
    const text = events
      .filter((e) => e.event === 'text_delta')
      .map((e) => JSON.parse(e.data).text as string)
      .join('')
    expect(text).toContain('/compact')
  })

  it('/clear --yes 清空当前会话消息后返回成功', async () => {
    const { app, ctx, sessionId } = await setup()
    // 先放一条消息
    await appendMessage(ctx.db, sessionId, {
      role: 'user',
      content: [{ _tag: 'text', text: 'hello' }],
    })
    expect(await getEntries(ctx.db, sessionId)).toHaveLength(1)

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '/clear --yes' }),
    })
    expect(res.status).toBe(200)
    const events = parseSSEEvents(await res.text())
    const text = events
      .filter((e) => e.event === 'text_delta')
      .map((e) => JSON.parse(e.data).text as string)
      .join('')
    expect(text).toContain('已清空')
    // 消息已被清除
    expect(await getEntries(ctx.db, sessionId)).toHaveLength(0)
  })

  it('/clear 缺 --yes 拒绝且消息保留', async () => {
    const { app, ctx, sessionId } = await setup()
    await appendMessage(ctx.db, sessionId, {
      role: 'user',
      content: [{ _tag: 'text', text: 'keep' }],
    })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '/clear' }),
    })
    expect(res.status).toBe(200)
    expect(await getEntries(ctx.db, sessionId)).toHaveLength(1)
  })

  it('config.slashCommands.enabled 过滤：未启用命令返回提示而非执行', async () => {
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const session = await createSession(db, 'Test')
    const ctx = createServerContext({
      db,
      llmRegistry: createRegistry(),
      config: { ...DEFAULT_CONFIG, slashCommands: { enabled: ['/help'] } },
      chatStream: mockChatStream,
    })
    const app = createChatRoute(ctx)
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, message: '/compact' }),
    })
    expect(res.status).toBe(200)
    const events = parseSSEEvents(await res.text())
    const text = events
      .filter((e) => e.event === 'text_delta')
      .map((e) => JSON.parse(e.data).text as string)
      .join('')
    expect(text).toContain('未启用')
  })

  it('未知斜杠命令回退为正常消息发给 agent', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '/foobarbaz' }),
    })
    expect(res.status).toBe(200)
    const events = parseSSEEvents(await res.text())
    const types = events.map((e) => e.event)
    // 回退到 agent 路径：mockChatStream 会产出 'Hello' 文本 + done
    expect(types).toContain('text_delta')
    expect(types).toContain('done')
    const text = events
      .filter((e) => e.event === 'text_delta')
      .map((e) => JSON.parse(e.data).text as string)
      .join('')
    expect(text).toContain('Hello')
  })
})

describe('chat route (control endpoints)', () => {
  it('POST /abort without active run returns aborted: false', async () => {
    const { app } = await setup()
    const res = await app.request('/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { aborted: boolean }
    expect(body.aborted).toBe(false)
  })

  // P0-4：占位期间（tryAcquire 后、register 前）run 尚无 state，控制端点
  // 返回明确 409 RUN_STARTING，而非静默 false 或崩溃。
  it('占位期间 abort/pause/resume/steer 返回 409 RUN_STARTING', async () => {
    const { app, ctx, sessionId } = await setup()
    // 预置占位：模拟 POST 已通过并发守卫、SSE 回调尚未 register 的窗口
    expect(ctx.agentManager.tryAcquire(sessionId)).toBe(true)

    const cases: Array<[string, Record<string, string>]> = [
      ['/abort', { sessionId }],
      ['/pause', { sessionId }],
      ['/resume', { sessionId }],
      ['/steer', { sessionId, message: 'm' }],
    ]
    for (const [path, body] of cases) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(409)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe('RUN_STARTING')
    }

    // 占位释放后恢复原行为（200 + false）
    ctx.agentManager.unregister(sessionId)
    const res = await app.request('/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { aborted: boolean }).aborted).toBe(false)
  })

  it('POST /pause without active run returns paused: false', async () => {
    const { app } = await setup()
    const res = await app.request('/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { paused: boolean }).paused).toBe(false)
  })

  it('P1：pause/resume 级联子 agent run（后台任务随主 run 暂停/恢复）', async () => {
    const { app, ctx, sessionId } = await setup()
    const parentState = { status: { _tag: 'running' } } as never
    const childState = { status: { _tag: 'running' } } as never
    ctx.agentManager.register({ sessionId, state: parentState, deps: {} as never })
    const childId = 'child-session-1'
    ctx.agentManager.register({
      sessionId: childId,
      parentSessionId: sessionId,
      state: childState,
      deps: {} as never,
    })

    const pauseRes = await app.request('/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    expect(pauseRes.status).toBe(200)
    expect(((await pauseRes.json()) as { paused: boolean }).paused).toBe(true)
    expect(ctx.agentManager.get(sessionId)?.state.status._tag).toBe('paused')
    expect(ctx.agentManager.get(childId)?.state.status._tag).toBe('paused')

    const resumeRes = await app.request('/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    expect(resumeRes.status).toBe(200)
    expect(((await resumeRes.json()) as { resumed: boolean }).resumed).toBe(true)
    expect(ctx.agentManager.get(sessionId)?.state.status._tag).toBe('running')
    expect(ctx.agentManager.get(childId)?.state.status._tag).toBe('running')
  })

  it('POST /resume without active run returns resumed: false', async () => {
    const { app } = await setup()
    const res = await app.request('/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { resumed: boolean }).resumed).toBe(false)
  })

  it('POST /steer without active run returns steered: false', async () => {
    const { app } = await setup()
    const res = await app.request('/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope', message: 'msg' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { steered: boolean }).steered).toBe(false)
  })

  it('P1：工作流运行期间 steer 路由到实际 workflow run（此前恒 false 静默丢失）', async () => {
    const { app, ctx, sessionId } = await setup()
    const wfSession = await createSession(
      ctx.db,
      'workflow: deploy 01-01 00:00',
      undefined,
      'workflow',
    )
    ctx.workflowBusyBySession.set(sessionId, wfSession.id)
    ctx.agentManager.register({
      sessionId: wfSession.id,
      state: { steeringQueue: [] } as never,
      deps: {} as never,
    })

    const res = await app.request('/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '改用 pnpm 安装' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { steered: boolean }).steered).toBe(true)
    // 指令已注入 workflow run 的 steering 队列（路由到 busy 映射的工作流会话）
    const wfRun = ctx.agentManager.get(wfSession.id)
    expect(wfRun).toBeDefined()
    const steeringQueue = (wfRun?.state as { steeringQueue: string[] } | undefined)?.steeringQueue
    expect(steeringQueue).toContain('改用 pnpm 安装')
  })
})

describe('POST / 多模态与文件上下文', () => {
  let tmpCwd: string | undefined
  afterEach(() => {
    if (tmpCwd) {
      rmSync(tmpCwd, { recursive: true, force: true })
      tmpCwd = undefined
    }
  })

  it('images 字段随消息持久化为 image part', async () => {
    const { app, sessionId, ctx } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        message: '看图',
        images: [{ mediaType: 'image/png', data: 'BASE64DATA' }],
      }),
    })
    expect(res.status).toBe(200)
    await res.text() // 消费 SSE 流
    const entries = await getEntries(ctx.db, sessionId)
    const userMsg = entries.find((e) => !('_tag' in e) && e.role === 'user')
    expect(userMsg).toBeTruthy()
    const imagePart = (userMsg as { content: Array<{ _tag: string }> }).content.find(
      (p) => p._tag === 'image',
    )
    expect(imagePart).toBeTruthy()
  })

  it('纯图片消息（无文本）被放行并持久化为 image part', async () => {
    const { app, sessionId, ctx } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        images: [{ mediaType: 'image/png', data: 'BASE64DATA' }],
      }),
    })
    expect(res.status).toBe(200)
    await res.text() // 消费 SSE 流
    const entries = await getEntries(ctx.db, sessionId)
    const userMsg = entries.find((e) => !('_tag' in e) && e.role === 'user')
    expect(userMsg).toBeTruthy()
    const content = (userMsg as { content: Array<{ _tag: string }> }).content
    expect(content.some((p) => p._tag === 'image')).toBe(true)
    expect(content.some((p) => p._tag === 'text')).toBe(false)
  })

  it('无文本无图片时返回可操作的 400', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, images: [] }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain('消息内容不能为空')
  })

  it('files 字段写入文件快照', async () => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'c0de-files-'))
    await writeFile(join(tmpCwd, 'tmp.txt'), 'hello file context')
    const { app, sessionId, ctx } = await setup({ cwd: tmpCwd })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'q', files: ['tmp.txt'] }),
    })
    expect(res.status).toBe(200)
    await res.text()
    const snapshots = await getFileSnapshots(ctx.db, sessionId)
    expect(
      snapshots.some((s) => s.filePath === 'tmp.txt' && s.content === 'hello file context'),
    ).toBe(true)
  })

  it('无 images/files 时行为不变（向后兼容）', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'plain text' }),
    })
    expect(res.status).toBe(200)
  })
})

describe('commands route', () => {
  it('GET / 返回内置斜杠命令', async () => {
    const { ctx } = await setup()
    const app = createCommandsRoute(ctx)
    const res = await app.request('/', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { commands: Array<{ name: string }> }
    const names = body.commands.map((c) => c.name)
    expect(names).toContain('help')
    expect(names).toContain('clear')
    expect(names).toContain('model')
  })
})

describe('workflowz 关键词 steering 注入', () => {
  /** 构造捕获 chatStream：记录 request.messages 供断言 steering 内容。 */
  function makeCapturingStream(captured: Array<{ role: string; content: unknown }>) {
    return (
      _ctx: unknown,
      request: { messages: Array<{ role: string; content: unknown }> },
    ): AsyncGenerator<StreamChunk> => {
      for (const m of request.messages) captured.push(m)
      return mockChatStream()
    }
  }

  async function setupWithCapture() {
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const session = await createSession(db, 'Test')
    const captured: Array<{ role: string; content: unknown }> = []
    const ctx = createServerContext({
      db,
      llmRegistry: createRegistry(),
      chatStream: makeCapturingStream(captured),
    })
    const app = createChatRoute(ctx)
    return { app, ctx, sessionId: session.id, captured }
  }

  it('workflowz 消息注入含已注册工作流名的 steering system 消息', async () => {
    const { app, ctx, sessionId, captured } = await setupWithCapture()

    // 注册自定义工作流，使 steering 通知包含可辨识的名字
    const customWf: WorkflowEntry = {
      meta: {
        name: 'test-steering-wf',
        description: 'A custom workflow for steering injection test',
      },
      source: 'user',
      execute: async () => ({ output: 'done' }),
    }
    ctx.workflowRegistry?.register(customWf)

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '请 workflowz 帮我分析这段代码' }),
    })
    expect(res.status).toBe(200)
    await res.text() // 消费 SSE 流

    // steering system 消息含 workflow-notice + 自定义工作流名
    const steeringMsgs = captured.filter(
      (m) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('workflow-notice'),
    )
    expect(steeringMsgs.length).toBeGreaterThan(0)
    const notice = String(steeringMsgs[0]?.content)
    expect(notice).toContain('test-steering-wf')
    expect(notice).toContain('A custom workflow for steering injection test')
    // 也应包含 builtin 工作流（registry → wfList 映射完整性）
    expect(notice).toContain('security-audit')
  })

  it('无 workflowz 关键词时不注入 steering 通知', async () => {
    const { app, sessionId, captured } = await setupWithCapture()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '请帮我分析这段代码' }),
    })
    expect(res.status).toBe(200)
    await res.text()

    const steeringMsgs = captured.filter(
      (m) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('workflow-notice'),
    )
    expect(steeringMsgs).toHaveLength(0)
  })

  it('workflowz 在代码块内不触发 steering（prose 感知）', async () => {
    const { app, sessionId, captured } = await setupWithCapture()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        message: '看这个 ```workflowz``` 代码',
      }),
    })
    expect(res.status).toBe(200)
    await res.text()

    const steeringMsgs = captured.filter(
      (m) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('workflow-notice'),
    )
    expect(steeringMsgs).toHaveLength(0)
  })
})

describe('SSE 心跳', () => {
  it('startHeartbeat 每 30s 发送 heartbeat 帧', async () => {
    vi.useFakeTimers()
    try {
      const writeSSE = vi.fn().mockResolvedValue(undefined)
      const stream = { writeSSE } as unknown as SSEStreamingApi
      const stop = startHeartbeat(stream)

      await vi.advanceTimersByTimeAsync(61_000)
      expect(writeSSE).toHaveBeenCalledTimes(2)
      expect(writeSSE).toHaveBeenCalledWith({ event: 'heartbeat', data: '' })

      stop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(writeSSE).toHaveBeenCalledTimes(2) // stop 后不再发送
    } finally {
      vi.useRealTimers()
    }
  })

  it('心跳间隔严格小于前端 90s 静默看门狗（防长任务误杀）', () => {
    // web/services/chat.ts 看门狗 90_000ms；心跳必须远小于它，
    // 否则 bash 120s 上限/权限 5 分钟/子 agent 长跑期间连接仍会被误杀。
    expect(SSE_HEARTBEAT_INTERVAL_MS).toBeLessThan(90_000)
    expect(90_000 / SSE_HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(3)
  })
})

describe('P0-2 项目信任门禁', () => {
  let tmpDir: string | undefined
  let prevHome: string | undefined
  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    }
    // 恢复 HOME，避免隔离配置泄漏到同 worker 的其他测试。
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    prevHome = undefined
  })

  /** 建临时项目目录（含 .c0de/config.json）+ 注册项目 + 绑定会话。
   *  将 HOME 指向临时空目录以隔离全局配置（否则用户 ~/.c0de/config.json 的 auto
   *  会渗入门禁判定）；globalConfig 提供时写入隔离 HOME 的 .c0de/config.json。 */
  async function setupTrustScenario(
    projectConfig: Record<string, unknown>,
    globalConfig?: Record<string, unknown>,
  ): Promise<{ app: ReturnType<typeof createChatRoute>; sessionId: string; projectId: string }> {
    tmpDir = mkdtempSync(join(tmpdir(), 'c0de-trust-'))
    const homeDir = join(tmpDir, 'home')
    const projDir = join(tmpDir, 'proj')
    await mkdir(join(homeDir, '.c0de'), { recursive: true })
    prevHome = process.env.HOME
    process.env.HOME = homeDir
    if (globalConfig) {
      await writeFile(join(homeDir, '.c0de', 'config.json'), JSON.stringify(globalConfig), 'utf-8')
    }
    await mkdir(join(projDir, '.c0de'), { recursive: true })
    await writeFile(join(projDir, '.c0de', 'config.json'), JSON.stringify(projectConfig), 'utf-8')
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const project = await fromDirectory(db, projDir)
    const session = await createSession(db, 'TrustMe', project.id)
    const ctx = createServerContext({
      db,
      llmRegistry: createRegistry(),
      cwd: projDir,
      chatStream: mockChatStream,
    })
    const app = createChatRoute(ctx)
    return { app, sessionId: session.id, projectId: project.id }
  }

  it('未信任项目 + auto 权限配置 → 409 TRUST_REQUIRED，信任后放行', async () => {
    const { app, sessionId, projectId } = await setupTrustScenario({
      permission: { defaultMode: 'auto' },
    })
    const first = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'hi' }),
    })
    expect(first.status).toBe(409)
    const firstBody = (await first.json()) as {
      error: { code: string; details: { projectId: string; items: Array<{ kind: string }> } }
    }
    expect(firstBody.error.code).toBe('TRUST_REQUIRED')
    expect(firstBody.error.details.projectId).toBe(projectId)
    expect(firstBody.error.details.items.map((i) => i.kind)).toContain('permission-auto')

    // 信任后（一次性）→ 放行
    await trustProject(dbHandle as DB, projectId)
    const second = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'hi' }),
    })
    expect(second.status).toBe(200)
    const events = parseSSEEvents(await second.text())
    expect(events.some((e) => e.event === 'done')).toBe(true)
  })

  it('未信任项目但配置无风险项 → 不拦截', async () => {
    const { app, sessionId } = await setupTrustScenario({
      permission: { defaultMode: 'default' },
      plugins: { enabled: [] },
    })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'hi' }),
    })
    expect(res.status).toBe(200)
  })

  it('未信任项目 + 全局 auto（项目无风险）→ 409 拦截（全局权限风险兜底）', async () => {
    const { app, sessionId, projectId } = await setupTrustScenario(
      { permission: { defaultMode: 'default' } },
      { permission: { defaultMode: 'auto' } },
    )
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'hi' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      error: {
        code: string
        details: { projectId: string; items: Array<{ kind: string; detail: string }> }
      }
    }
    expect(body.error.code).toBe('TRUST_REQUIRED')
    expect(body.error.details.projectId).toBe(projectId)
    const item = body.error.details.items.find((i) => i.kind === 'permission-auto')
    expect(item?.detail).toContain('全局配置')
  })

  it('信任后 + 全局 auto（项目无风险）→ 放行（全局不复检）', async () => {
    const { app, sessionId, projectId } = await setupTrustScenario(
      { permission: { defaultMode: 'default' } },
      { permission: { defaultMode: 'auto' } },
    )
    await trustProject(dbHandle as DB, projectId)
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'hi' }),
    })
    expect(res.status).toBe(200)
  })

  it('未信任项目 + 启用插件配置 → 409 携带 plugins-enabled 风险项', async () => {
    const { app, sessionId } = await setupTrustScenario({
      plugins: { enabled: ['evil-plugin'] },
    })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'hi' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      error: { code: string; details: { items: Array<{ kind: string }> } }
    }
    expect(body.error.code).toBe('TRUST_REQUIRED')
    expect(body.error.details.items.map((i) => i.kind)).toContain('plugins-enabled')
  })

  it('信任后配置漂移（新增风险键）→ 重新 409 TRUST_REQUIRED（指纹复检）', async () => {
    const { app, sessionId, projectId } = await setupTrustScenario({
      permission: { defaultMode: 'auto' },
    })
    await trustProject(dbHandle as DB, projectId)

    // 模拟仓库 git pull 后新增插件风险键：指纹漂移 → 门禁复发，而非永久信任。
    await writeFile(
      join(tmpDir as string, 'proj', '.c0de', 'config.json'),
      JSON.stringify({
        permission: { defaultMode: 'auto' },
        plugins: { enabled: ['evil-plugin'] },
      }),
      'utf-8',
    )
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'hi' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      error: { code: string; details: { items: Array<{ kind: string }> } }
    }
    expect(body.error.code).toBe('TRUST_REQUIRED')
    expect(body.error.details.items.map((i) => i.kind)).toContain('plugins-enabled')
  })

  it('信任后配置未变 → 不再拦截', async () => {
    const { app, sessionId, projectId } = await setupTrustScenario({
      permission: { defaultMode: 'auto' },
    })
    await trustProject(dbHandle as DB, projectId)
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'hi' }),
    })
    expect(res.status).toBe(200)
  })
})

describe('/workflow run 专用斜杠通道', () => {
  const TRIVIAL_WF: WorkflowEntry = {
    meta: { name: 'slash-wf', description: 'trivial slash workflow' },
    source: 'user',
    execute: async () => ({ output: 'slash-wf-done' }),
  }

  it('执行注册工作流：SSE 返回结果并创建带时间戳标题的工作流会话', async () => {
    const { app, ctx, sessionId } = await setup()
    ctx.workflowRegistry?.register(TRIVIAL_WF)
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '/workflow run slash-wf' }),
    })
    expect(res.status).toBe(200)
    const events = parseSSEEvents(await res.text())
    const types = events.map((e) => e.event)
    expect(types).toContain('done')
    const delta = events.find((e) => e.event === 'text_delta')
    expect(delta?.data).toContain('slash-wf-done')

    const all = await listAllSessions(dbHandle as DB)
    const wfSession = all.find((s) => s.agentType === 'workflow')
    expect(wfSession).toBeTruthy()
    // 标题含时间戳：多次运行在会话树中可区分
    expect(wfSession?.title).toMatch(/^workflow:slash-wf \d{2}-\d{2} \d{2}:\d{2}$/)
    expect(wfSession?.projectId).toBeNull()
  })

  it('主 run 活跃时拒绝并发发起工作流（RUN_ACTIVE）', async () => {
    const { app, ctx, sessionId } = await setup()
    ctx.agentManager.register({ sessionId, state: {} as never, deps: {} as never })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '/workflow run slash-wf' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RUN_ACTIVE')
  })

  it('未知工作流返回可用列表提示', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '/workflow run ghost-wf' }),
    })
    expect(res.status).toBe(200)
    const events = parseSSEEvents(await res.text())
    const delta = events.find((e) => e.event === 'text_delta')
    expect(delta?.data).toContain('未知工作流')
    expect(delta?.data).toContain('security-audit')
  })

  it('同一作用域已有工作流执行 → 409 RUN_ACTIVE 且不产生孤儿会话（并发守卫）', async () => {
    const { app, ctx, sessionId } = await setup()
    ctx.workflowRegistry?.register(TRIVIAL_WF)
    // 模拟同项目已有进行中的工作流运行（无 projectId 会话按目录为作用域）
    ctx.workflowBusyByScope.set(`dir:${ctx.cwd}`, 'wf-running')

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '/workflow run slash-wf' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RUN_ACTIVE')

    // 守卫先于 createSession：不残留空工作流会话行
    const all = await listAllSessions(dbHandle as DB)
    expect(all.filter((s) => s.agentType === 'workflow')).toHaveLength(0)
  })

  it('工作流运行期间同会话发普通消息 → 409 RUN_ACTIVE（对称拦截）', async () => {
    const { app, ctx, sessionId } = await setup()
    // 该会话有进行中的工作流（发起会话 → 工作流会话映射）
    ctx.workflowBusyBySession.set(sessionId, 'wf-running')

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '工作流跑的时候发条普通消息' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RUN_ACTIVE')
  })

  it('工作流运行期间对发起会话 abort/pause/resume → 路由到工作流 run', async () => {
    const { app, ctx, sessionId } = await setup()
    ctx.workflowBusyBySession.set(sessionId, 'wf-running')
    const abortSpy = vi.spyOn(ctx.agentManager, 'abort').mockReturnValue(true)
    const pauseSpy = vi.spyOn(ctx.agentManager, 'pause').mockReturnValue(true)
    const resumeSpy = vi.spyOn(ctx.agentManager, 'resume').mockReturnValue(true)

    for (const [path, key, spy] of [
      ['/abort', 'aborted', abortSpy],
      ['/pause', 'paused', pauseSpy],
      ['/resume', 'resumed', resumeSpy],
    ] as const) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, boolean>
      expect(body[key]).toBe(true)
      expect(spy).toHaveBeenCalledWith('wf-running')
    }
  })
})
