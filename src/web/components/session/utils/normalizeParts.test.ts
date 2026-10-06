import type { Message, MessageContent } from '@shared/types/message.js'
import { describe, expect, it } from 'vitest'
import {
  mergeSessionMessages,
  mergeToolMessages,
  normalizeParts,
} from '@/components/session/utils/normalizeParts.js'

function msg(role: Message['role'], parts: MessageContent[]): Message {
  return { id: '1', sessionId: 's', role, content: parts, tokenCount: 0, createdAt: 1 }
}

describe('normalizeParts', () => {
  it('纯文本消息映射为 text 块', () => {
    const blocks = normalizeParts(msg('user', [{ _tag: 'text', text: 'hi' }]))
    expect(blocks).toEqual([{ type: 'text', role: 'user', text: 'hi', partIndex: 0 }])
  })

  it('thinking 映射为 thinking 块', () => {
    const blocks = normalizeParts(msg('assistant', [{ _tag: 'thinking', text: 'hmm' }]))
    expect(blocks).toEqual([{ type: 'thinking', text: 'hmm', partIndex: 0 }])
  })

  it('steering 映射为 steering 块', () => {
    const blocks = normalizeParts(msg('user', [{ _tag: 'steering', text: 's' }]))
    expect(blocks).toEqual([{ type: 'steering', text: 's', partIndex: 0 }])
  })

  it('tool_call + 同 id tool_result(success) 合并为 completed', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'tool_call', id: 't1', tool: 'read', input: { path: 'a.ts' } },
        { _tag: 'tool_result', id: 't1', tool: '', output: { _tag: 'success', output: 'x' } },
      ]),
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'tool',
      id: 't1',
      tool: 'read',
      input: { path: 'a.ts' },
      status: 'completed',
    })
  })

  it('tool_result(error) → error 状态', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'tool_call', id: 't2', tool: 'bash', input: { command: 'ls' } },
        { _tag: 'tool_result', id: 't2', tool: '', output: { _tag: 'error', error: 'boom' } },
      ]),
    )
    expect(blocks[0]).toMatchObject({ status: 'error' })
  })

  it('tool_result(permission_required) → paused 状态', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'tool_call', id: 't3', tool: 'edit', input: {} },
        {
          _tag: 'tool_result',
          id: 't3',
          tool: '',
          output: { _tag: 'permission_required', reason: 'r' },
        },
      ]),
    )
    expect(blocks[0]).toMatchObject({ status: 'paused' })
  })

  it('truncated 结果也算 completed', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'tool_call', id: 't4', tool: 'grep', input: {} },
        {
          _tag: 'tool_result',
          id: 't4',
          tool: '',
          output: { _tag: 'truncated', output: 'o', truncated: true, totalLines: 100 },
        },
      ]),
    )
    expect(blocks[0]).toMatchObject({ status: 'completed' })
  })

  it('仅有 tool_call 无 result → running 状态', () => {
    const blocks = normalizeParts(
      msg('assistant', [{ _tag: 'tool_call', id: 't5', tool: 'read', input: {} }]),
    )
    expect(blocks[0]).toMatchObject({ status: 'running' })
  })

  it('孤立的 tool_result（无对应 call）仍渲染为 tool 块', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        {
          _tag: 'tool_result',
          id: 't6',
          tool: 'glob',
          output: { _tag: 'success', output: 'f.ts' },
        },
      ]),
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'tool', id: 't6', tool: 'glob', status: 'completed' })
  })

  it('混合多 part 保持顺序', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'text', text: 'a' },
        { _tag: 'tool_call', id: 't7', tool: 'read', input: {} },
        { _tag: 'tool_result', id: 't7', tool: '', output: { _tag: 'success', output: 'r' } },
        { _tag: 'text', text: 'b' },
      ]),
    )
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool', 'text'])
  })
})

describe('mergeToolMessages', () => {
  it('把独立 tool 消息的 tool_result 合并回对应 assistant 消息', () => {
    const assistant = msg('assistant', [
      { _tag: 'tool_call', id: 'tc1', tool: 'read', input: { path: 'a.ts' } },
    ])
    const tool = msg('tool', [
      { _tag: 'tool_result', id: 'tc1', tool: 'read', output: { _tag: 'success', output: 'x' } },
    ])
    const merged = mergeToolMessages([assistant, tool])
    // tool 消息被并入，只剩一条 assistant
    expect(merged).toHaveLength(1)
    expect(merged[0]?.role).toBe('assistant')
    expect(merged[0]?.content).toEqual([
      { _tag: 'tool_call', id: 'tc1', tool: 'read', input: { path: 'a.ts' } },
      { _tag: 'tool_result', id: 'tc1', tool: 'read', output: { _tag: 'success', output: 'x' } },
    ])
    // 合并后单条 assistant 经 normalizeParts 应得到一张 completed 卡（非两张）
    const blocks = normalizeParts(merged[0] as Message)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'tool', status: 'completed' })
  })

  it('不修改入参数组与原消息 content（浅拷贝）', () => {
    const assistant = msg('assistant', [{ _tag: 'tool_call', id: 'tc1', tool: 'read', input: {} }])
    const tool = msg('tool', [
      { _tag: 'tool_result', id: 'tc1', tool: 'read', output: { _tag: 'success', output: 'x' } },
    ])
    const original = [assistant, tool]
    mergeToolMessages(original)
    expect(original).toHaveLength(2)
    expect(assistant.content).toHaveLength(1)
  })

  it('tool_result 无对应 assistant tool_call 时保留该 tool 消息', () => {
    const tool = msg('tool', [
      { _tag: 'tool_result', id: 'orphan', tool: 'read', output: { _tag: 'error', error: 'e' } },
    ])
    const merged = mergeToolMessages([tool])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.role).toBe('tool')
  })

  it('实时形态（assistant 已含 tool_call+tool_result）是 no-op', () => {
    const assistant = msg('assistant', [
      { _tag: 'tool_call', id: 'tc1', tool: 'read', input: {} },
      { _tag: 'tool_result', id: 'tc1', tool: 'read', output: { _tag: 'success', output: 'x' } },
    ])
    const merged = mergeToolMessages([assistant])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.content).toHaveLength(2)
  })

  it('多轮多工具：各自正确合并', () => {
    const a1 = msg('assistant', [{ _tag: 'tool_call', id: 't1', tool: 'read', input: {} }])
    const t1 = msg('tool', [
      { _tag: 'tool_result', id: 't1', tool: 'read', output: { _tag: 'success', output: '1' } },
    ])
    const a2 = msg('assistant', [{ _tag: 'tool_call', id: 't2', tool: 'grep', input: {} }])
    const t2 = msg('tool', [
      { _tag: 'tool_result', id: 't2', tool: 'grep', output: { _tag: 'success', output: '2' } },
    ])
    const merged = mergeToolMessages([a1, t1, a2, t2])
    expect(merged).toHaveLength(2)
    expect(merged[0]?.content.some((p) => p._tag === 'tool_result' && p.id === 't1')).toBe(true)
    expect(merged[1]?.content.some((p) => p._tag === 'tool_result' && p.id === 't2')).toBe(true)
  })

  // 回归：并行工具轮次的多条 tool_result 存于同一条 tool 消息时，merge 只
  // find 首个 result——其余结果随整条消息 drop 静默丢失：时间线里对应调用
  // 永远显示 running，结果内容人间蒸发。
  it('合并同一条 tool 消息的全部 tool_result（此前只合并首个，其余静默丢失）', () => {
    const assistant = msg('assistant', [
      { _tag: 'tool_call', id: 'c1', tool: 'read', input: { path: 'a.ts' } },
      { _tag: 'tool_call', id: 'c2', tool: 'grep', input: { pattern: 'x' } },
    ])
    const tool = msg('tool', [
      {
        _tag: 'tool_result',
        id: 'c1',
        tool: 'read',
        output: { _tag: 'success', output: 'content-a' },
      },
      {
        _tag: 'tool_result',
        id: 'c2',
        tool: 'grep',
        output: { _tag: 'success', output: '2 hits' },
      },
    ])
    const merged = mergeToolMessages([assistant, tool])
    expect(merged).toHaveLength(1)
    const content = merged[0]?.content ?? []
    expect(content.filter((p) => p._tag === 'tool_result')).toHaveLength(2)
    // 合并后经 normalizeParts：两张 completed 卡，无 running 卡
    const blocks = normalizeParts(merged[0] as Message)
    expect(blocks).toHaveLength(2)
    expect(blocks.every((b) => b.type === 'tool' && b.status === 'completed')).toBe(true)
  })

  // 回归：首个 result 无对应 call 时，此前整条消息被跳过——后续本可合并的
  // result 一并丢失。修复后逐一处理：无主的保留、有主的合并。
  it('首个 tool_result 无主时不阻塞同消息其余结果的合并', () => {
    const assistant = msg('assistant', [{ _tag: 'tool_call', id: 'c2', tool: 'grep', input: {} }])
    const tool = msg('tool', [
      {
        _tag: 'tool_result',
        id: 'c1',
        tool: 'read',
        output: { _tag: 'success', output: 'orphan' },
      },
      {
        _tag: 'tool_result',
        id: 'c2',
        tool: 'grep',
        output: { _tag: 'success', output: '2 hits' },
      },
    ])
    const merged = mergeToolMessages([assistant, tool])
    // assistant（合并了 c2）+ tool（保留孤儿 c1）
    expect(merged).toHaveLength(2)
    expect(merged[0]?.role).toBe('assistant')
    expect(merged[0]?.content.some((p) => p._tag === 'tool_result' && p.id === 'c2')).toBe(true)
    expect(merged[1]?.role).toBe('tool')
    expect(merged[1]?.content).toEqual([
      {
        _tag: 'tool_result',
        id: 'c1',
        tool: 'read',
        output: { _tag: 'success', output: 'orphan' },
      },
    ])
  })
})

describe('mergeSessionMessages', () => {
  /** 持久化消息（服务端 id + 服务端时间戳）。 */
  function persisted(id: string, role: Message['role'], parts: MessageContent[]): Message {
    return { id, sessionId: 's', role, content: parts, tokenCount: 0, createdAt: 1000 }
  }
  /** 乐观消息（本轮 SSE 实时归约产物：客户端 id + 客户端时间戳）。 */
  function optimistic(id: string, role: Message['role'], parts: MessageContent[]): Message {
    return { id, sessionId: 's', role, content: parts, tokenCount: 0, createdAt: 1001 }
  }

  // 回归：乐观副本与服务端副本 id 不同（客户端 generateId vs 服务端 appendMessage），
  // 历史重取（窗口聚焦 refetchOnWindowFocus / shake 应用 / 附着结束刷新）后两者
  // 同时在列表中——整轮对话重复渲染两份。
  it('已持久化的乐观消息不重复渲染（同一轮只出现一次）', () => {
    const history = [
      persisted('u-db', 'user', [{ _tag: 'text', text: 'hello' }]),
      persisted('a-db', 'assistant', [{ _tag: 'text', text: 'hi there' }]),
    ]
    const live = [
      optimistic('u-live', 'user', [{ _tag: 'text', text: 'hello' }]),
      optimistic('a-live', 'assistant', [{ _tag: 'text', text: 'hi there' }]),
    ]
    const merged = mergeSessionMessages(history, live)
    expect(merged.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(merged.every((m) => m.id.endsWith('-db'))).toBe(true)
  })

  // thinking 不落库：乐观 assistant 含 thinking 部分时仍须与持久化副本配对，
  // 否则每条带思考的回复都会重复一遍。
  it('乐观副本含未落库的 thinking 部分时仍能配对', () => {
    const history = [persisted('a-db', 'assistant', [{ _tag: 'text', text: 'done' }])]
    const live = [
      optimistic('a-live', 'assistant', [
        { _tag: 'thinking', text: 'let me think' },
        { _tag: 'text', text: 'done' },
      ]),
    ]
    expect(mergeSessionMessages(history, live)).toHaveLength(1)
  })

  // 工具轮次：持久化侧是 assistant(tool_call) + 独立 tool 消息，实时侧是同一条
  // assistant 内已配对 tool_result——两侧形态不同但属同一轮，不得重复渲染。
  it('工具轮次（实时已配对 / 历史分两条）不重复渲染且结果仍合并', () => {
    const history = [
      persisted('a-db', 'assistant', [
        { _tag: 'tool_call', id: 'tc1', tool: 'read', input: { path: 'a.ts' } },
      ]),
      persisted('t-db', 'tool', [
        { _tag: 'tool_result', id: 'tc1', tool: 'read', output: { _tag: 'success', output: 'x' } },
      ]),
    ]
    const live = [
      optimistic('a-live', 'assistant', [
        { _tag: 'tool_call', id: 'tc1', tool: 'read', input: { path: 'a.ts' } },
        { _tag: 'tool_result', id: 'tc1', tool: 'read', output: { _tag: 'success', output: 'x' } },
      ]),
    ]
    const merged = mergeSessionMessages(history, live)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.id).toBe('a-db')
    // 结果合并回 assistant：normalizeParts 得到一张 completed 卡
    expect(normalizeParts(merged[0] as Message)[0]).toMatchObject({
      type: 'tool',
      status: 'completed',
    })
  })

  // 未落库的乐观消息必须保留：中断的 run 半截回复不写库（loop 在轮次结束时才
  // 持久化 assistant），清空乐观副本会让用户已看到的半截内容凭空消失。
  it('历史中没有对应条目的乐观消息保留（中断轮次的半截回复不丢失）', () => {
    const history = [persisted('u-db', 'user', [{ _tag: 'text', text: 'run tests' }])]
    const live = [
      optimistic('u-live', 'user', [{ _tag: 'text', text: 'run tests' }]),
      optimistic('a-live', 'assistant', [{ _tag: 'text', text: 'halfway through…' }]),
    ]
    const merged = mergeSessionMessages(history, live)
    expect(merged.map((m) => m.id)).toEqual(['u-db', 'a-live'])
  })

  // @agent 提及：服务端在用户文本前注入派发指令后落库，内容与乐观副本不同——
  // 不剥离前缀时该条消息每次都重复渲染。
  it('服务端注入 @agent 指令前缀的用户消息仍能配对', () => {
    const history = [
      persisted('u-db', 'user', [
        { _tag: 'text', text: '[User requested subagent(s): coder]\n\nfix the bug' },
      ]),
    ]
    const live = [optimistic('u-live', 'user', [{ _tag: 'text', text: 'fix the bug' }])]
    expect(mergeSessionMessages(history, live)).toHaveLength(1)
  })

  // 相同的重复输入（同一句话发两次）：历史只落库一条时不得把两条都吞掉。
  it('重复的相同输入按数量配对，不吞掉未持久化的那条', () => {
    const history = [persisted('u1-db', 'user', [{ _tag: 'text', text: 'go' }])]
    const live = [
      optimistic('u1-live', 'user', [{ _tag: 'text', text: 'go' }]),
      optimistic('u2-live', 'user', [{ _tag: 'text', text: 'go' }]),
    ]
    const merged = mergeSessionMessages(history, live)
    expect(merged).toHaveLength(2)
    expect(merged.map((m) => m.id)).toEqual(['u1-db', 'u2-live'])
  })
})

// 回归：image part 此前被整个丢弃——纯图片消息渲染成空白行，
// 图文消息只见文字且因签名不含图片导致同一条消息在时间线上重复出现两份。
describe('normalizeParts 图片', () => {
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  it('image part 映射为 image 块', () => {
    const blocks = normalizeParts(
      msg('user', [{ _tag: 'image', mediaType: 'image/png', data: PNG }]),
    )
    expect(blocks).toEqual([{ type: 'image', mediaType: 'image/png', data: PNG, partIndex: 0 }])
  })

  it('图文消息同时产出 text 块和 image 块', () => {
    const blocks = normalizeParts(
      msg('user', [
        { _tag: 'text', text: '看图' },
        { _tag: 'image', mediaType: 'image/png', data: PNG },
      ]),
    )
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image'])
  })
})
