/**
 * 段指纹与 legacy 迁移单测。归属：session 层段管理逻辑（segmentFingerprint /
 * migrateLegacyDetails）。无更合适的既有测试文件承载，故新建；后续若合并 session
 * 层测试可并入。
 */
import { describe, expect, it } from 'vitest'
import type { LLMSegment } from '../shared/types/agent.js'
import type { ChatTool } from '../shared/types/llm.js'
import { migrateLegacyDetails, segmentFingerprint } from './session.js'

const tools: ChatTool[] = [{ name: 'read', description: '读文件', parameters: { type: 'object' } }]

describe('segmentFingerprint', () => {
  it('相同 systemPrompt + tools → 相同指纹', () => {
    expect(segmentFingerprint('sys', tools)).toBe(segmentFingerprint('sys', tools))
  })
  it('systemPrompt 变化 → 指纹变化', () => {
    expect(segmentFingerprint('sys', tools)).not.toBe(segmentFingerprint('sys2', tools))
  })
  it('tools 变化 → 指纹变化', () => {
    expect(segmentFingerprint('sys', tools)).not.toBe(segmentFingerprint('sys', []))
  })
  it('tools 顺序不同但集合相同 → 指纹相同（规格化）', () => {
    const reversed = [...tools].reverse()
    expect(segmentFingerprint('sys', tools)).toBe(segmentFingerprint('sys', reversed))
  })
})

describe('migrateLegacyDetails', () => {
  it('无 llmDetails 且无 segments → 原样返回', () => {
    const meta = { foo: 1 }
    expect(migrateLegacyDetails(meta)).toEqual(meta)
  })
  it('已有 segments → 不重复迁移', () => {
    const seg: LLMSegment = {
      id: 's1',
      fingerprint: 'x',
      provider: 'p',
      model: 'm',
      systemPrompt: 's',
      tools: [],
      startedAt: 1,
      trigger: 'initial',
      calls: [],
    }
    const out = migrateLegacyDetails({ segments: [seg] })
    expect(out.segments).toEqual([seg])
    expect(out.llmDetails).toBeUndefined()
  })
  it('llmDetails → 单个 legacy segment，calls 提取 responseText', () => {
    const legacy = {
      llmDetails: [
        {
          id: 'd1',
          timestamp: 10,
          model: 'm',
          provider: 'p',
          role: { _tag: 'default' },
          systemPrompt: 'sys',
          messages: [],
          tools,
          responseChunks: [
            { _tag: 'text', text: 'hel' },
            { _tag: 'text', text: 'lo' },
            { _tag: 'done' },
          ],
          thinking: 'hmm',
          usage: { input: 1, output: 2, cacheRead: 3 },
          latency: { firstToken: 5, total: 10 },
          cost: 0.1,
          contextWindow: 8000,
        },
      ],
    }
    const out = migrateLegacyDetails(legacy)
    expect(out.llmDetails).toBeUndefined()
    expect(out.segments).toHaveLength(1)
    const seg = (out.segments as LLMSegment[])[0]
    if (!seg) throw new Error('missing segment')
    expect(seg.trigger).toBe('initial')
    expect(seg.systemPrompt).toBe('sys')
    expect(seg.tools).toEqual(tools)
    expect(seg.contextWindow).toBe(8000)
    expect(seg.calls).toHaveLength(1)
    const call = seg.calls[0]
    if (!call) throw new Error('missing call')
    expect(call.responseText).toBe('hello')
    expect(call.thinking).toBe('hmm')
    expect(call.usage).toEqual({ input: 1, output: 2, cacheRead: 3 })
  })
})
