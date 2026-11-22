// 交互辅助纯逻辑（core/assist.ts）：对话裁剪、prompt 构建、回复清洗。
import { describe, expect, it } from 'vitest'
import type { Message } from '../shared/types/message.js'
import {
  buildPredictionPrompt,
  buildRecapPrompt,
  PREDICTION_SKIP_REPLY,
  RECENT_MESSAGE_COUNT,
  recentTranscript,
  sanitizePrediction,
  sanitizeRecap,
} from './assist.js'

const msg = (role: 'user' | 'assistant', text: string, id = role + text): Message => ({
  id,
  sessionId: 's',
  role,
  content: [{ _tag: 'text', text }],
  tokenCount: 0,
  createdAt: 0,
})

describe('recentTranscript', () => {
  it('只取 user/assistant 的文本部分，带角色前缀', () => {
    const out = recentTranscript([
      msg('user', '帮我修 bug', 'u1'),
      {
        ...msg('assistant', '', 'a1'),
        content: [
          { _tag: 'text', text: '好的' },
          { _tag: 'tool_call', id: 't1', tool: 'bash', input: {} },
          { _tag: 'thinking', text: '内心独白' },
        ],
      },
    ])
    expect(out).toBe('用户: 帮我修 bug\n助手: 好的')
  })

  it(`只保留最近 ${RECENT_MESSAGE_COUNT} 条`, () => {
    const all = Array.from({ length: RECENT_MESSAGE_COUNT + 4 }, (_, i) =>
      msg(i % 2 ? 'assistant' : 'user', `m${i}`, `id${i}`),
    )
    const lines = recentTranscript(all).split('\n')
    expect(lines).toHaveLength(RECENT_MESSAGE_COUNT)
    expect(lines[0]).toContain('m4')
  })
})

describe('sanitizePrediction', () => {
  it('NO_PREDICTION / 空白 → null', () => {
    expect(sanitizePrediction(PREDICTION_SKIP_REPLY)).toBeNull()
    expect(sanitizePrediction('  \n ')).toBeNull()
    expect(sanitizePrediction(undefined)).toBeNull()
  })

  it('剥掉整段包裹引号', () => {
    expect(sanitizePrediction('"继续修"')).toBe('继续修')
    expect(sanitizePrediction('“继续修”')).toBe('继续修')
    expect(sanitizePrediction('`继续修`')).toBe('继续修')
  })

  it('超长回复（模型自说自话）→ null', () => {
    expect(sanitizePrediction('x'.repeat(501))).toBeNull()
    expect(sanitizePrediction('x'.repeat(500))).toBe('x'.repeat(500))
  })
})

describe('sanitizeRecap', () => {
  it('空白 → null；折叠换行为一行；截断到 200 字', () => {
    expect(sanitizeRecap('')).toBeNull()
    expect(sanitizeRecap('目标\n是  修 bug')).toBe('目标 是 修 bug')
    expect(sanitizeRecap('y'.repeat(250))).toHaveLength(200)
  })
})

describe('prompt 构建', () => {
  it('预测 prompt 带对话与用户口吻/简短/NO_PREDICTION 指令', () => {
    const p = buildPredictionPrompt('用户: 修 bug\n助手: 好的')
    expect(p).toContain('用户: 修 bug')
    expect(p).toContain(PREDICTION_SKIP_REPLY)
    expect(p).toContain('口吻')
  })

  it('回顾 prompt 带现状+下一步指令', () => {
    const p = buildRecapPrompt('用户: 修 bug')
    expect(p).toContain('用户: 修 bug')
    expect(p).toContain('下一步')
  })
})
