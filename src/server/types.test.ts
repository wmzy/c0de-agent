// src/server/types.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../core/config.js'
import type { DB } from '../db/client.js'
import { createTestDB, resetTestDB } from '../db/test-utils.js'
import { createRegistry } from '../llm/registry.js'
import { createServerContext } from './context.js'
import type { ChatRequest, ConfirmRequest, SteerRequest } from './types.js'

let dbHandle: DB
beforeAll(async () => {
  dbHandle = await createTestDB()
})
afterAll(async () => {
  await dbHandle.close()
})
afterEach(async () => {
  await resetTestDB(dbHandle)
})

describe('server/types', () => {
  it('createServerContext 组装所有服务', async () => {
    const db = dbHandle
    const ctx = createServerContext({
      db,
      llmRegistry: createRegistry(),
    })
    expect(ctx.db).toBe(db)
    expect(ctx.config).toEqual(DEFAULT_CONFIG)
    expect(ctx.toolRegistry).toBeDefined()
    expect(ctx.llmRegistry).toBeDefined()
    expect(ctx.agentManager).toBeDefined()
    expect(ctx.agentRegistry).toBeDefined()
    expect(ctx.agentRegistry.has('general')).toBe(true)
    expect(ctx.agentRegistry.has('researcher')).toBe(true)
    expect(ctx.agentRegistry.list().length).toBeGreaterThanOrEqual(4)
    expect(typeof ctx.cwd).toBe('string')
  })

  it('createServerContext 接受自定义 config 和 cwd', async () => {
    const db = dbHandle
    const customConfig = { ...DEFAULT_CONFIG, defaultModel: 'custom-model' }
    const ctx = createServerContext({
      db,
      llmRegistry: createRegistry(),
      config: customConfig,
      cwd: '/tmp/test',
    })
    expect(ctx.config.defaultModel).toBe('custom-model')
    expect(ctx.cwd).toBe('/tmp/test')
  })

  it('createServerContext 用 config.permission.defaultMode 初始化 permissionMode', async () => {
    const db = dbHandle
    // 默认 config → permissionMode 为 default
    const ctxDefault = createServerContext({ db, llmRegistry: createRegistry() })
    expect(ctxDefault.permissionMode).toBe('default')
    // config 设 auto → permissionMode 跟随
    const ctxAuto = createServerContext({
      db,
      llmRegistry: createRegistry(),
      config: { ...DEFAULT_CONFIG, permission: { defaultMode: 'auto' } },
    })
    expect(ctxAuto.permissionMode).toBe('auto')
  })

  it('请求类型满足结构约束', () => {
    const chat: ChatRequest = { sessionId: 's1', message: 'hello' }
    const steer: SteerRequest = { sessionId: 's1', message: 'stop' }
    const confirm: ConfirmRequest = { toolCallId: 'tc1', approved: true }
    expect(chat.sessionId).toBe('s1')
    expect(steer.message).toBe('stop')
    expect(confirm.approved).toBe(true)
  })
})
