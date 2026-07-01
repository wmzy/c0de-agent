import type { LLMCall, LLMSegment } from '@shared/types/agent.js'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CallRow, SegmentHeader } from './LLMDetail.js'

const tools: LLMSegment['tools'] = [
  {
    name: 'read',
    description: '读取文件内容',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'edit',
    description: '编辑文件',
    parameters: { type: 'object', properties: {} },
  },
]

const call: LLMCall = {
  id: 'c1',
  timestamp: 1,
  usage: { input: 10, output: 5 },
  latency: { firstToken: 100, total: 1500 },
  cost: 0.001,
  responseText: 'hello',
}

const segment: LLMSegment = {
  id: 's1',
  fingerprint: 'fp',
  provider: 'openai',
  model: 'gpt-4',
  systemPrompt: 'You are helpful',
  tools,
  startedAt: 1,
  trigger: 'initial',
  contextWindow: 8000,
  calls: [call],
}

const emptySegment: LLMSegment = { ...segment, id: 's2', tools: [], calls: [] }

describe('SegmentHeader', () => {
  afterEach(() => cleanup())

  it('渲染 model / provider / trigger', () => {
    render(<SegmentHeader segment={segment} />)
    const el = screen.getByTestId('segment-header')
    expect(el.textContent).toContain('gpt-4')
    expect(el.textContent).toContain('openai')
    expect(el.textContent).toContain('initial')
  })

  it('Tools 面板标题显示工具条数', () => {
    render(<SegmentHeader segment={segment} />)
    expect(screen.getByTestId('tools-summary').textContent).toContain('Tools (2)')
  })

  it('渲染每个工具的名称、描述和 parameters', () => {
    const { container } = render(<SegmentHeader segment={segment} />)
    const text = container.textContent ?? ''
    expect(text).toContain('读取文件内容')
    expect(text).toContain('编辑文件')
    expect(text).toContain('"properties"')
  })

  it('工具为空时显示空态', () => {
    render(<SegmentHeader segment={emptySegment} />)
    expect(screen.getByTestId('tools-summary').textContent).toContain('Tools (0)')
  })

  it('System Prompt 可折叠展示', () => {
    const { container } = render(<SegmentHeader segment={segment} />)
    // 默认折叠：内容不在可见渲染中（仍常驻 DOM，但折叠态）；展开后可见
    expect(container.textContent).toContain('You are helpful')
  })
})

describe('CallRow', () => {
  afterEach(() => cleanup())

  it('渲染 responseText', () => {
    render(<CallRow call={call} index={1} />)
    const el = screen.getByTestId('call-row')
    expect(el.textContent).toContain('hello')
  })

  it('渲染 token 用量和格式化延迟', () => {
    render(<CallRow call={call} index={1} />)
    const el = screen.getByTestId('call-row')
    expect(el.textContent).toContain('10')
    expect(el.textContent).toContain('5')
    expect(el.textContent).toContain('1.50s')
    expect(el.textContent).toContain('$0.0010')
  })

  it('渲染调用序号', () => {
    render(<CallRow call={call} index={3} />)
    expect(screen.getByTestId('call-row').textContent).toContain('调用 #3')
  })

  it('有 thinking 时渲染 Thinking 区块', () => {
    const withThinking: LLMCall = { ...call, id: 'c2', thinking: '逐步推理过程' }
    const { container } = render(<CallRow call={withThinking} index={1} />)
    expect(container.textContent).toContain('Thinking')
    expect(container.textContent).toContain('逐步推理过程')
  })

  it('无 thinking 时不渲染 Thinking 区块', () => {
    const { container } = render(<CallRow call={call} index={1} />)
    expect(container.textContent).not.toContain('Thinking')
  })

  it('finishReason 非空时展示', () => {
    const truncated: LLMCall = { ...call, id: 'c3', finishReason: 'length' }
    render(<CallRow call={truncated} index={1} />)
    expect(screen.getByTestId('call-row').textContent).toContain('length')
  })
})
