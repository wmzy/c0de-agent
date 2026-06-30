/**
 * 多 agent 端到端集成测试（spec: multi-agent-design §4.5）。
 * 验证主 agent → task 工具(subagent_type) → runSubAgent 派发 → 子 agent yield 结构化结果
 * → 结果回传父 agent，并发射 subagent_* 事件、子 session 记录 agentType。
 *
 * 归并建议：多 agent 相关跨层集成场景归此文件；单 agent loop 行为见 core/loop.test.ts。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import type { Registry } from '../../llm/registry.js'
import { listSessions } from '../../session/index.js'
import { createSession } from '../../session/session.js'
import type { AgentEvent } from '../../shared/types/agent.js'
import type { StreamChunk } from '../../shared/types/llm.js'
import { createDefaultRegistry } from '../../tools/index.js'
import { autoAllowChecker } from '../../tools/permission.js'
import { createAgent, runAgent } from '../agent.js'
import { DEFAULT_CONFIG } from '../config.js'
import type { LoopDeps } from '../loop.js'
import { BUILTIN_AGENTS, createAgentRegistry } from './index.js'

let dbHandle: Awaited<ReturnType<typeof createDB>> | undefined
afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
})

/** mock chatStream 调用序列：父派发 task(researcher) → 子 yield → 父总结。 */
function mockMultiAgentStream(): (() => AsyncGenerator<StreamChunk>) | undefined {
  let call = 0
  return () => {
    const n = call++
    async function* gen() {
      if (n === 0) {
        // 父轮 0：派发 task 工具（researcher）
        yield { _tag: 'tool_call_start', id: 'tc1', name: 'task' } as const
        yield {
          _tag: 'tool_call_end',
          id: 'tc1',
          argumentsFinal: JSON.stringify({
            subagent_type: 'researcher',
            prompt: 'find auth files',
            description: 'auth scout',
          }),
        } as const
        yield { _tag: 'done' } as const
      } else if (n === 1) {
        // 子 agent（researcher）轮：yield 结构化结果
        yield { _tag: 'tool_call_start', id: 'yc1', name: 'yield' } as const
        yield {
          _tag: 'tool_call_end',
          id: 'yc1',
          argumentsFinal: JSON.stringify({ data: { files: ['src/auth.ts', 'src/session.ts'] } }),
        } as const
        yield { _tag: 'done' } as const
      } else {
        // 父轮 1：总结
        yield { _tag: 'text', text: 'Research complete.' } as const
        yield { _tag: 'done' } as const
      }
    }
    return gen()
  }
}

describe('multi-agent integration', () => {
  it('主 agent 派发 researcher 子 agent，子 agent yield 结构化结果回传父', async () => {
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)

    const agentRegistry = createAgentRegistry()
    for (const def of BUILTIN_AGENTS) agentRegistry.register(def)

    const deps: LoopDeps = {
      db,
      llmRegistry: {} as Registry,
      toolRegistry: createDefaultRegistry(),
      permission: autoAllowChecker,
      config: DEFAULT_CONFIG,
      cwd: '/tmp',
      agentRegistry,
      chatStream: mockMultiAgentStream() as unknown as LoopDeps['chatStream'],
    }

    const parentSession = await createSession(db, 'integration test')
    const state = await createAgent(
      parentSession,
      { provider: 'mock', model: 'mock', tools: ['task'], plugins: [] },
      deps,
    )

    const events: AgentEvent[] = []
    for await (const ev of runAgent(state, [{ _tag: 'text', text: 'research auth' }], deps)) {
      events.push(ev)
    }

    // 1. 父派发了 task 工具
    const taskStart = events.find((e) => e._tag === 'tool_call_start' && e.tool === 'task')
    expect(taskStart).toBeTruthy()

    // 2. 发射了 subagent_start / subagent_end（agentType=researcher）
    const subStart = events.find((e) => e._tag === 'subagent_start' && e.agentType === 'researcher')
    const subEnd = events.find((e) => e._tag === 'subagent_end' && e.agentType === 'researcher')
    expect(subStart).toBeTruthy()
    expect(subEnd).toBeTruthy()
    if (subEnd && subEnd._tag === 'subagent_end') expect(subEnd.success).toBe(true)

    // 3. task 工具结果含子 agent yield 的结构化 data
    const taskEnd = events.find((e) => e._tag === 'tool_call_end' && e.id === 'tc1')
    expect(taskEnd).toBeTruthy()
    if (taskEnd && taskEnd._tag === 'tool_call_end') {
      expect(taskEnd.result._tag).toBe('success')
      if (taskEnd.result._tag === 'success') {
        expect(taskEnd.result.metadata?.data).toEqual({
          files: ['src/auth.ts', 'src/session.ts'],
        })
      }
    }

    // 4. 子 session 在 DB 中记录 agentType='researcher'
    const all = await listSessions(db)
    const child = all.find((s) => s.agentType === 'researcher')
    expect(child).toBeTruthy()
    expect(child?.id).not.toBe(parentSession.id)
  })

  it('未注册 agentType 时 task 工具返回 error（e2e）', async () => {
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)

    const deps: LoopDeps = {
      db,
      llmRegistry: {} as Registry,
      toolRegistry: createDefaultRegistry(),
      permission: autoAllowChecker,
      config: DEFAULT_CONFIG,
      cwd: '/tmp',
      agentRegistry: createAgentRegistry(), // 空注册表
      chatStream: mockMultiAgentStream() as unknown as LoopDeps['chatStream'],
    }

    const parentSession = await createSession(db, 'error test')
    const state = await createAgent(
      parentSession,
      { provider: 'mock', model: 'mock', tools: ['task'], plugins: [] },
      deps,
    )

    const events: AgentEvent[] = []
    for await (const ev of runAgent(state, [{ _tag: 'text', text: 'x' }], deps)) {
      events.push(ev)
    }

    const taskEnd = events.find((e) => e._tag === 'tool_call_end' && e.id === 'tc1')
    expect(taskEnd).toBeTruthy()
    if (taskEnd && taskEnd._tag === 'tool_call_end') {
      expect(taskEnd.result._tag).toBe('error')
      if (taskEnd.result._tag === 'error') {
        expect(taskEnd.result.error).toMatch(/Unknown agent type/i)
      }
    }
  })
})
