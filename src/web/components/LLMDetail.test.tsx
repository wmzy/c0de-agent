import type { LLMCall, LLMSegment } from '@shared/types/agent.js'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SegmentBreak, SegmentFooter } from './LLMDetail.js'

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
  calls: [call, { ...call, id: 'c2', cost: 0.002, latency: { firstToken: 50, total: 800 } }],
}

const emptySegment: LLMSegment = { ...segment, id: 's2', tools: [], calls: [] }

describe('SegmentFooter', () => {
  afterEach(() => cleanup())

  it('渲染 model / provider', () => {
    render(<SegmentFooter segment={segment} />)
    const el = screen.getByTestId('segment-footer')
    expect(el.textContent).toContain('gpt-4')
    expect(el.textContent).toContain('openai')
  })

  it('渲染 Σ token 汇总', () => {
    render(<SegmentFooter segment={segment} />)
    const el = screen.getByTestId('segment-footer')
    // (10+5) + (10+5) = 30
    expect(el.textContent).toContain('30')
  })

  it('渲染 Σ cost 汇总', () => {
    render(<SegmentFooter segment={segment} />)
    const el = screen.getByTestId('segment-footer')
    expect(el.textContent).toContain('$0.003')
  })

  it('渲染 Σ latency 汇总', () => {
    render(<SegmentFooter segment={segment} />)
    const el = screen.getByTestId('segment-footer')
    // 1500 + 800 = 2300ms = 2.30s
    expect(el.textContent).toContain('2.30s')
  })

  it('渲染调用次数', () => {
    render(<SegmentFooter segment={segment} />)
    const el = screen.getByTestId('segment-footer')
    expect(el.textContent).toContain('2 次调用')
  })

  it('Tools 面板标题显示工具条数', () => {
    render(<SegmentFooter segment={segment} />)
    expect(screen.getByTestId('tools-summary').textContent).toContain('Tools (2)')
  })

  it('渲染每个工具的名称、描述和 parameters', () => {
    const { container } = render(<SegmentFooter segment={segment} />)
    const text = container.textContent ?? ''
    expect(text).toContain('读取文件内容')
    expect(text).toContain('编辑文件')
    expect(text).toContain('"properties"')
  })

  it('工具为空时显示空态', () => {
    render(<SegmentFooter segment={emptySegment} />)
    expect(screen.getByTestId('tools-summary').textContent).toContain('Tools (0)')
  })

  it('System Prompt 默认折叠但内容在 DOM', () => {
    const { container } = render(<SegmentFooter segment={segment} />)
    expect(container.textContent).toContain('You are helpful')
  })
})

describe('SegmentBreak', () => {
  afterEach(() => cleanup())

  it('trigger=initial 不渲染（返回 null）', () => {
    const { container } = render(<SegmentBreak segment={{ ...segment, trigger: 'initial' }} />)
    expect(container.querySelector('[data-testid="segment-break"]')).toBeNull()
  })

  it('trigger=model_change 渲染分隔线 + 标签', () => {
    const { container } = render(<SegmentBreak segment={{ ...segment, trigger: 'model_change' }} />)
    const el = container.querySelector('[data-testid="segment-break"]')
    expect(el).toBeTruthy()
    expect(el?.textContent).toContain('模型切换')
  })

  it('trigger=compaction 渲染会话压缩标签', () => {
    const { container } = render(<SegmentBreak segment={{ ...segment, trigger: 'compaction' }} />)
    const el = container.querySelector('[data-testid="segment-break"]')
    expect(el).toBeTruthy()
    expect(el?.textContent).toContain('会话压缩')
  })

  it('trigger=system_prompt_change 渲染系统提示词变更标签', () => {
    const { container } = render(
      <SegmentBreak segment={{ ...segment, trigger: 'system_prompt_change' }} />,
    )
    expect(container.querySelector('[data-testid="segment-break"]')?.textContent).toContain(
      '系统提示词变更',
    )
  })

  it('trigger=tools_change 渲染工具集变更标签', () => {
    const { container } = render(<SegmentBreak segment={{ ...segment, trigger: 'tools_change' }} />)
    expect(container.querySelector('[data-testid="segment-break"]')?.textContent).toContain(
      '工具集变更',
    )
  })
})
