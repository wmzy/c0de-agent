// agent:// 解析器测试：全量视图 / json-path 取值边界 / fuzzy 候选建议。
// DB 用 test-utils 的 PGlite 内存实例（createTestDB + resetTestDB）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createTestDB, resetTestDB } from '../../db/test-utils.js'
import { appendMessage } from '../../session/message.js'
import { createSession, updateSessionLastRun } from '../../session/session.js'
import type { MessageContent } from '../../shared/types/message.js'
import type { URLResolveContext } from '../../shared/types/tool.js'
import { createAgentResolver } from './agent-resolver.js'

let db: DB
let ctx: URLResolveContext
let callSeq = 0

beforeAll(async () => {
  db = await createTestDB()
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await resetTestDB(db)
  callSeq = 0
  const caller = await createSession(db, 'Caller')
  ctx = { cwd: '/tmp', session: { id: caller.id, cwd: '/tmp' } }
})

/** 追加一对 yield 消息（assistant tool_call + tool result），模拟子 agent 产出落库。 */
async function appendYield(
  sessionId: string,
  data: unknown,
  opts?: { type?: string; error?: boolean },
): Promise<void> {
  callSeq += 1
  const id = `yield-call-${callSeq}`
  const input: Record<string, unknown> = { data }
  if (opts?.type) input.type = opts.type
  const callPart: MessageContent = { _tag: 'tool_call', id, tool: 'yield', input }
  await appendMessage(db, sessionId, { role: 'assistant', content: [callPart] })
  const output = opts?.error
    ? ({ _tag: 'error', error: 'schema mismatch' } as const)
    : ({ _tag: 'success', output: 'Result submitted.' } as const)
  const resultPart: MessageContent = { _tag: 'tool_result', id, tool: 'yield', output }
  await appendMessage(db, sessionId, { role: 'tool', content: [resultPart] })
}

async function makeChild(parentId: string, title = 'Scout work', agentType = 'scout') {
  return createSession(db, title, undefined, agentType, 'web', parentId)
}

describe('agent:// full view', () => {
  it('渲染 yield 结构化产出（含 labels）与最新 assistant 文本', async () => {
    const parent = await createSession(db, 'Parent')
    const child = await makeChild(parent.id, 'Scout: api 调查', 'scout')
    await appendYield(child.id, { report: 'found 3 issues', items: [1, 2] }, { type: 'findings' })
    await appendMessage(db, child.id, {
      role: 'assistant',
      content: [{ _tag: 'text', text: 'Scout done.' }],
    })
    const content = await createAgentResolver({ db }).resolve(`agent://${child.id}`, ctx)
    expect(content).toContain('# Agent session: Scout: api 调查')
    expect(content).toContain('- Agent type: scout')
    expect(content).toContain('### findings')
    expect(content).toContain('"report": "found 3 issues"')
    expect(content).toContain('## Last assistant message')
    expect(content).toContain('Scout done.')
  })

  it('无 yield 且无 assistant 文本时呈现进度视图（消息计数）', async () => {
    const parent = await createSession(db, 'Parent')
    const child = await makeChild(parent.id)
    await appendMessage(db, child.id, {
      role: 'user',
      content: [{ _tag: 'text', text: 'go investigate' }],
    })
    const content = await createAgentResolver({ db }).resolve(`agent://${child.id}`, ctx)
    expect(content).toContain('No output yet')
    expect(content).toContain('1 message(s)')
  })

  it('后台任务运行中：视图带 lastRun 状态', async () => {
    const parent = await createSession(db, 'Parent')
    const child = await makeChild(parent.id, 'bg task', 'coder')
    await updateSessionLastRun(db, child.id, { status: 'running', startedAt: Date.now() })
    const content = await createAgentResolver({ db }).resolve(`agent://${child.id}`, ctx)
    expect(content).toContain('- Run status: running')
  })

  it('error 的 yield 不算产出，全量视图只渲染被接受的 yield', async () => {
    const parent = await createSession(db, 'Parent')
    const child = await makeChild(parent.id)
    await appendYield(child.id, { bad: true }, { error: true })
    await appendYield(child.id, { good: true })
    const content = await createAgentResolver({ db }).resolve(`agent://${child.id}`, ctx)
    expect(content).toContain('"good": true')
    expect(content).not.toContain('"bad": true')
    expect(content).toContain('1 section')
  })

  it('尾斜杠容忍：agent://<id>/ 等价全量视图', async () => {
    const parent = await createSession(db, 'Parent')
    const child = await makeChild(parent.id)
    await appendYield(child.id, { ok: 1 })
    const content = await createAgentResolver({ db }).resolve(`agent://${child.id}/`, ctx)
    expect(content).toContain('"ok": 1')
  })
})

describe('agent:// json-path 提取', () => {
  it('字符串值直接作正文返回（不做 JSON 转义）', async () => {
    const parent = await createSession(db, 'Parent')
    const child = await makeChild(parent.id)
    await appendYield(child.id, { report: 'found 3 issues' })
    const content = await createAgentResolver({ db }).resolve(`agent://${child.id}/report`, ctx)
    expect(content).toBe('found 3 issues')
  })

  it('数组数字下标与嵌套对象按键下钻', async () => {
    const parent = await createSession(db, 'Parent')
    const child = await makeChild(parent.id)
    await appendYield(child.id, { items: [1, 2], a: { b: { c: 'deep' } } })
    const resolver = createAgentResolver({ db })
    expect(await resolver.resolve(`agent://${child.id}/items/1`, ctx)).toBe('2')
    expect(await resolver.resolve(`agent://${child.id}/items`, ctx)).toBe('[\n  1,\n  2\n]')
    expect(await resolver.resolve(`agent://${child.id}/a/b/c`, ctx)).toBe('deep')
  })

  it('miss 路径报 absent（越界下标 / 缺键 / 对数组用非数字段 / 对原始值下钻）', async () => {
    const parent = await createSession(db, 'Parent')
    const child = await makeChild(parent.id)
    await appendYield(child.id, { items: [1], name: 'x', n: 5 })
    const resolver = createAgentResolver({ db })
    await expect(resolver.resolve(`agent://${child.id}/items/5`, ctx)).rejects.toThrow(
      /JSON path not found/,
    )
    await expect(resolver.resolve(`agent://${child.id}/missing`, ctx)).rejects.toThrow(
      /JSON path not found/,
    )
    await expect(resolver.resolve(`agent://${child.id}/items/x`, ctx)).rejects.toThrow(
      /JSON path not found/,
    )
    await expect(resolver.resolve(`agent://${child.id}/name/x`, ctx)).rejects.toThrow(
      /JSON path not found/,
    )
    await expect(resolver.resolve(`agent://${child.id}/0`, ctx)).rejects.toThrow(
      /JSON path not found/,
    )
  })

  it('多次 yield 以数组承载：下标 0 起取段', async () => {
    const parent = await createSession(db, 'Parent')
    const child = await makeChild(parent.id)
    await appendYield(child.id, { summary: 's1' }, { type: 'part1' })
    await appendYield(child.id, { summary: 's2' }, { type: 'part2' })
    const resolver = createAgentResolver({ db })
    expect(await resolver.resolve(`agent://${child.id}/0/summary`, ctx)).toBe('s1')
    expect(await resolver.resolve(`agent://${child.id}/1/summary`, ctx)).toBe('s2')
  })

  it('null 与布尔等非字符串值按 JSON 渲染', async () => {
    const parent = await createSession(db, 'Parent')
    const child = await makeChild(parent.id)
    await appendYield(child.id, { nothing: null, flag: true })
    const resolver = createAgentResolver({ db })
    expect(await resolver.resolve(`agent://${child.id}/nothing`, ctx)).toBe('null')
    expect(await resolver.resolve(`agent://${child.id}/flag`, ctx)).toBe('true')
  })

  it('URL 编码的键名段可解码命中', async () => {
    const parent = await createSession(db, 'Parent')
    const child = await makeChild(parent.id)
    await appendYield(child.id, { 'key with space': 'v' })
    const content = await createAgentResolver({ db }).resolve(
      `agent://${child.id}/key%20with%20space`,
      ctx,
    )
    expect(content).toBe('v')
  })

  it('无 yield 产出时路径提取报错并引导全量视图', async () => {
    const parent = await createSession(db, 'Parent')
    const child = await makeChild(parent.id)
    await appendMessage(db, child.id, {
      role: 'assistant',
      content: [{ _tag: 'text', text: '只有文本' }],
    })
    await expect(
      createAgentResolver({ db }).resolve(`agent://${child.id}/data`, ctx),
    ).rejects.toThrow(/no accepted yield output/)
  })
})

describe('agent:// not found 与 fuzzy 建议', () => {
  it('目标不存在：对 caller 的子会话做 fuzzy 建议（前缀截断粘贴可召回）', async () => {
    const parent = await createSession(db, 'Parent')
    const c1 = await makeChild(parent.id, 'c1')
    await makeChild(parent.id, 'c2')
    await makeChild(parent.id, 'c3')
    ctx = { cwd: '/tmp', session: { id: parent.id, cwd: '/tmp' } }
    await expect(
      createAgentResolver({ db }).resolve(`agent://${c1.id.slice(0, 8)}`, ctx),
    ).rejects.toThrow(new RegExp(`Did you mean: agent://${c1.id}`))
  })

  it('caller 是子会话时：建议的是兄弟会话', async () => {
    const parent = await createSession(db, 'Parent')
    const c1 = await makeChild(parent.id, 'c1')
    const c2 = await makeChild(parent.id, 'c2')
    ctx = { cwd: '/tmp', session: { id: c1.id, cwd: '/tmp' } }
    await expect(
      createAgentResolver({ db }).resolve(`agent://${c2.id.slice(0, 10)}`, ctx),
    ).rejects.toThrow(new RegExp(`agent://${c2.id}`))
  })

  it('候选最多 5 个', async () => {
    const parent = await createSession(db, 'Parent')
    for (let i = 0; i < 8; i++) {
      await makeChild(parent.id, `c${i}`)
    }
    ctx = { cwd: '/tmp', session: { id: parent.id, cwd: '/tmp' } }
    // '-' 是每个 uuid 的子串：8 个子会话全命中，断言只报前 5 个
    const error = (await createAgentResolver({ db })
      .resolve('agent://-', ctx)
      .catch((e: unknown) => e)) as Error
    expect(error).toBeInstanceOf(Error)
    const suggestions = (error.message.match(/agent:\/\/[0-9a-f-]{36}/g) ?? []).length
    expect(suggestions).toBe(5)
  })

  it('无候选时提示 sessionId 的可信来源', async () => {
    await expect(
      createAgentResolver({ db }).resolve('agent://11111111-2222-4333-8444-555555555555', ctx),
    ).rejects.toThrow(/Tip: the session id comes from the task tool result/)
  })

  it('非法 uuid 输入按不存在处理（不触发 SQL 错误）', async () => {
    await expect(createAgentResolver({ db }).resolve('agent://not-a-uuid', ctx)).rejects.toThrow(
      /agent session not found: not-a-uuid/,
    )
  })

  it('缺 session id 报用法错误', async () => {
    await expect(createAgentResolver({ db }).resolve('agent://', ctx)).rejects.toThrow(
      /requires a session id/,
    )
  })
})
