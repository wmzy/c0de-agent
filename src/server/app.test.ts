// src/server/app.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { createRegistry } from '../llm/registry.js'
import type { StreamChunk } from '../shared/types/llm.js'
import { createApp } from './app.js'
import { createServerContext } from './context.js'

function mockChatStream(): AsyncGenerator<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    yield { _tag: 'text', text: 'response' }
    yield { _tag: 'done' }
  })()
}

let dbHandle: DB | undefined
afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
})

async function setupApp() {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  const cwd = mkdtempSync(join(tmpdir(), 'c0de-app-'))
  const ctx = createServerContext({
    db,
    llmRegistry: createRegistry(),
    cwd,
    chatStream: mockChatStream,
  })
  return { app: createApp(ctx), ctx, cwd }
}

describe('createApp (integration)', () => {
  it('GET / 返回服务信息', async () => {
    const { app } = await setupApp()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      name: string
      endpoints: string[]
    }
    expect(body.name).toBe('c0de-agent')
    expect(body.endpoints).toContain('/api/health')
  })

  it('GET /api/health 健康检查', async () => {
    const { app } = await setupApp()
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })

  it('完整聊天流程：创建会话 → 发送消息 → 接收 SSE', async () => {
    const { app } = await setupApp()

    // 创建会话
    const createRes = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Integration Test' }),
    })
    const session = (await createRes.json()) as { id: string }

    // 发送消息（SSE）
    const chatRes = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, message: 'Hello' }),
    })
    expect(chatRes.status).toBe(200)
    expect(chatRes.headers.get('content-type')).toContain('text/event-stream')
    const text = await chatRes.text()
    expect(text).toContain('text_delta')
    expect(text).toContain('done')
  })

  it('GET /api/tools 列出工具', async () => {
    const { app } = await setupApp()
    const res = await app.request('/api/tools')
    expect(res.status).toBe(200)
    const tools = (await res.json()) as unknown[]
    expect(tools.length).toBeGreaterThan(0)
  })

  it('GET /api/config 返回配置', async () => {
    const { app } = await setupApp()
    const res = await app.request('/api/config')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { config: { defaultProvider: string } }
    expect(body.config.defaultProvider).toBeDefined()
  })

  it('GET /api/files 列出文件', async () => {
    const { app, cwd } = await setupApp()
    writeFileSync(join(cwd, 'test.txt'), 'content')
    const res = await app.request('/api/files')
    expect(res.status).toBe(200)
    const files = (await res.json()) as { name: string }[]
    expect(files.some((f) => f.name === 'test.txt')).toBe(true)
  })

  it('未处理路由返回 404', async () => {
    const { app } = await setupApp()
    const res = await app.request('/api/nonexistent')
    expect(res.status).toBe(404)
  })
})
