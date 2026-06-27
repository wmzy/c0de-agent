import type { LLMDetail } from '@shared/types/agent.js'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LLMDetailPanel } from './LLMDetail.js'

const detail: LLMDetail = {
  id: 'd1',
  timestamp: 1,
  model: 'gpt-4',
  provider: 'openai',
  role: { _tag: 'default' },
  systemPrompt: 'You are helpful',
  messages: [],
  tools: [],
  responseChunks: [{ _tag: 'text', text: 'hello' }],
  usage: { input: 10, output: 5 },
  latency: { firstToken: 100, total: 1500 },
  cost: 0.001,
}

describe('LLMDetailPanel', () => {
  afterEach(() => cleanup())

  it('渲染模型名和 provider', () => {
    render(<LLMDetailPanel detail={detail} />)
    const el = screen.getByTestId('llm-detail')
    expect(el.textContent).toContain('gpt-4')
    expect(el.textContent).toContain('openai')
  })

  it('渲染 token 用量和格式化延迟', () => {
    render(<LLMDetailPanel detail={detail} />)
    const el = screen.getByTestId('llm-detail')
    expect(el.textContent).toContain('10')
    expect(el.textContent).toContain('5')
    expect(el.textContent).toContain('1.50s')
  })
})
