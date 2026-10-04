import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createTestDB, resetTestDB } from '../../db/test-utils.js'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import { createAgentRoute } from './agent.js'

type AgentRow = {
  name: string
  description: string
  mode: string
  source: string
  hasTools: boolean
}

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

async function setup() {
  const db = dbHandle
  const ctx = createServerContext({ db, llmRegistry: createRegistry() })
  const app = createAgentRoute(ctx)
  return { app, ctx }
}

describe('agent route', () => {
  it('GET / 返回所有 agent', async () => {
    const { app } = await setup()
    const res = await app.request('/', { method: 'GET' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { agents: AgentRow[] }
    expect(data.agents.length).toBeGreaterThanOrEqual(6)
  })

  it('GET / 包含 primary 和 subagent', async () => {
    const { app } = await setup()
    const res = await app.request('/', { method: 'GET' })
    const data = (await res.json()) as { agents: AgentRow[] }
    const modes = data.agents.map((a) => a.mode)
    expect(modes).toContain('primary')
    expect(modes).toContain('subagent')
  })

  it('GET / 每个 agent 有 name/description/mode/source', async () => {
    const { app } = await setup()
    const res = await app.request('/', { method: 'GET' })
    const data = (await res.json()) as { agents: AgentRow[] }
    for (const agent of data.agents) {
      expect(agent.name).toBeTruthy()
      expect(agent.description).toBeTruthy()
      expect(['subagent', 'primary', 'all']).toContain(agent.mode)
      expect(['builtin', 'user', 'project']).toContain(agent.source)
    }
  })
})
