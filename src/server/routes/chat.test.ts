import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../core/config.js'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import { fromDirectory } from '../../project/project.js'
import { createSession, getLLMDetails } from '../../session/session.js'
import type { StreamChunk } from '../../shared/types/llm.js'
import { createServerContext } from '../context.js'
import { createChatRoute, resolveAgentCwd } from './chat.js'

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

async function setup() {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  const session = await createSession(db, 'Test')
  const ctx = createServerContext({
    db,
    llmRegistry: createRegistry(),
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

  // 来源：修复 Web 前端 ToolToggle 全选（不带 tools）时，后端回退 config.tools.enabled:[]
  // 导致 LLM 无工具定义、无法 function call 的 bug。前端全选语义应为「启用全部注册工具」。
  it('POST / 不带 tools 时启用全部注册工具（不因 config.tools.enabled:[] 降级）', async () => {
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const session = await createSession(db, 'Test')
    // 复现 bug 配置：enabled 为空数组（曾被当作「默认全启用」，实为「无工具」）
    const ctx = createServerContext({
      db,
      llmRegistry: createRegistry(),
      config: { ...DEFAULT_CONFIG, tools: { enabled: [], disabled: [] } },
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
    // 消费完整 SSE 流，驱动 agentLoop 执行到 appendLLMDetail
    await res.text()

    // loop 持久化的 llmDetail.tools 即发送给 LLM 的工具定义；不带 tools 时启用全部注册工具
    const details = await getLLMDetails(db, session.id)
    expect(details).toHaveLength(1)
    const toolNames = details[0]?.tools.map((t) => t.name).sort()
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
      'read',
      'task',
      'write',
    ])
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
})
