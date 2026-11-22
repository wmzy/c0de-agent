import { describe, expect, it } from 'vitest'
import type { MessageRole } from '../shared/types/base.js'
import type { Message, MessageContent } from '../shared/types/message.js'
import { createDeltaRenderer, renderMessageBlock } from './render.js'

let seq = 0

function msg(role: MessageRole, content: MessageContent[]): Message {
  seq += 1
  return {
    id: `m${seq}`,
    sessionId: 's1',
    role,
    content,
    tokenCount: 10,
    createdAt: seq,
  }
}

const SECRET = 'secret_aB3dEfGh1JkLmNoP'

describe('createDeltaRenderer 增量切分', () => {
  it('首个 update 渲染全量，后续只渲染新增消息', () => {
    const renderer = createDeltaRenderer()
    const first = msg('user', [{ _tag: 'text', text: 'fix the login bug' }])
    const firstOut = renderer.render('s1', [first])
    expect(firstOut).toContain('fix the login bug')
    expect(firstOut).toContain('### Session update (user)')

    const second = msg('assistant', [{ _tag: 'text', text: 'looking into auth.ts' }])
    const secondOut = renderer.render('s1', [first, second])
    expect(secondOut).toContain('looking into auth.ts')
    expect(secondOut).not.toContain('fix the login bug')

    // 无新增 → null（调用方跳过本趟审查）
    expect(renderer.render('s1', [first, second])).toBeNull()
  })

  it('会话间互不干扰（per-session seen 计数）', () => {
    const renderer = createDeltaRenderer()
    const a = msg('user', [{ _tag: 'text', text: 'session a message' }])
    renderer.render('a', [a])
    expect(renderer.render('a', [a])).toBeNull()
    const b = msg('user', [{ _tag: 'text', text: 'session b message' }])
    const out = renderer.render('b', [b])
    expect(out).toContain('session b message')
  })

  it('消息数回缩（/clear、压缩归档）视为重置，重看全量', () => {
    const renderer = createDeltaRenderer()
    const old1 = msg('user', [{ _tag: 'text', text: 'old 1' }])
    const old2 = msg('user', [{ _tag: 'text', text: 'old 2' }])
    renderer.render('s1', [old1, old2])
    const fresh = msg('user', [{ _tag: 'text', text: 'fresh after clear' }])
    const out = renderer.render('s1', [fresh])
    expect(out).toContain('fresh after clear')
  })

  it('新增消息全部无内容时不产出文本（seen 计数仍推进）', () => {
    const renderer = createDeltaRenderer()
    const empty = msg('assistant', [])
    expect(renderer.render('s1', [empty])).toBeNull()
    const next = msg('user', [{ _tag: 'text', text: 'next' }])
    expect(renderer.render('s1', [empty, next])).toContain('next')
  })
})

describe('内容渲染', () => {
  it('凭证在进入渲染文本前被脱敏（text/thinking/tool 参数/结果）', () => {
    const message = msg('assistant', [
      { _tag: 'text', text: `the token is ${SECRET} please check` },
      { _tag: 'tool_call', id: 't1', tool: 'bash', input: { command: `echo ${SECRET}` } },
      {
        _tag: 'tool_result',
        id: 't1',
        tool: 'bash',
        output: { _tag: 'success', output: `printed ${SECRET}` },
      },
    ])
    const block = renderMessageBlock(message)
    expect(block).not.toContain(SECRET)
    expect(block?.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('工具调用渲染为「tool 名 + 参数摘要」紧凑形态', () => {
    const message = msg('assistant', [
      {
        _tag: 'tool_call',
        id: 't1',
        tool: 'edit',
        input: { file_path: 'src/a.ts', new_string: 'x' },
      },
    ])
    const block = renderMessageBlock(message)
    expect(block).toContain('tool_call `edit`(')
    expect(block).toContain('file_path')
  })

  it('工具结果只渲染首行（多行输出截断为首行）', () => {
    const message = msg('tool', [
      {
        _tag: 'tool_result',
        id: 't1',
        tool: 'bash',
        output: { _tag: 'success', output: 'first line of output\nsecond line\nthird line' },
      },
    ])
    const block = renderMessageBlock(message)
    expect(block).toContain('tool_result `bash`: first line of output')
    expect(block).not.toContain('second line')
  })

  it('错误结果带 [error] 标记并渲染错误首行', () => {
    const message = msg('tool', [
      {
        _tag: 'tool_result',
        id: 't1',
        tool: 'bash',
        output: { _tag: 'error', error: 'command failed\nstack details' },
      },
    ])
    const block = renderMessageBlock(message)
    expect(block).toContain('tool_result `bash` [error]: command failed')
    expect(block).not.toContain('stack details')
  })

  it('thinking/steering 带标签，图像标注省略字节', () => {
    const message = msg('assistant', [
      { _tag: 'thinking', text: 'plan the approach' },
      { _tag: 'steering', text: 'user adds: prefer tabs' },
      { _tag: 'image', mediaType: 'image/png', data: 'aGk=' },
    ])
    const block = renderMessageBlock(message)
    expect(block).toContain('thinking: plan the approach')
    expect(block).toContain('steering: user adds: prefer tabs')
    expect(block).toContain('image image/png (bytes omitted)')
  })

  it('超长文本截断带标记', () => {
    const long = 'x'.repeat(5000)
    const block = renderMessageBlock(msg('user', [{ _tag: 'text', text: long }]))
    expect(block).toContain('…[truncated]')
    expect(block).not.toContain(long)
  })
})
