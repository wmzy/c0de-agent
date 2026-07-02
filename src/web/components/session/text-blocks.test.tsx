import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 代码引用组件依赖 Shiki 高亮，mock 避免测试中加载 WASM/语法包
vi.mock('../../utils/highlight.js', () => ({
  highlightCode: vi.fn(async (code: string) => `<pre><code>${code}</code></pre>`),
}))

import { AssistantTextBlock } from './AssistantTextBlock.js'
import { ReasoningBlock } from './ReasoningBlock.js'
import { UserTextBlock } from './UserTextBlock.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('UserTextBlock', () => {
  it('渲染文本', () => {
    render(<UserTextBlock text="hello" />)
    expect(screen.getByTestId('user-text')).toHaveTextContent('hello')
  })
})

describe('AssistantTextBlock', () => {
  it('渲染内容并带复制按钮', () => {
    render(<AssistantTextBlock text="**bold**" />)
    expect(screen.getByTestId('assistant-text')).toBeInTheDocument()
    expect(screen.getByTestId('copy-button')).toBeInTheDocument()
  })

  it('有 completedAt 时显示时间', () => {
    render(<AssistantTextBlock text="hi" completedAt={1700000000000} />)
    expect(screen.getByTestId('assistant-time')).toBeInTheDocument()
  })

  it('含代码引用时渲染展开控件', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <AssistantTextBlock text="@[src/a.ts:1-2]" />
      </QueryClientProvider>,
    )
    expect(screen.queryByTestId('assistant-code-refs')).toBeTruthy()
    const toggle = screen.queryByTestId('code-ref-toggle')
    expect(toggle).toBeTruthy()
    expect(toggle?.textContent).toContain('src/a.ts:1-2')
  })

  it('点击引用展开后拉取并显示代码片段', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ path: 'a.ts', content: 'line1\nline2\nline3' }),
      }),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <AssistantTextBlock text="@[src/a.ts:1-2]" />
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByTestId('code-ref-toggle'))
    await waitFor(() => {
      const body = screen.getByTestId('code-ref-body')
      expect(body.textContent).toContain('line1')
      expect(body.textContent).toContain('line2')
    })
  })

  it('无引用时不渲染引用区块', () => {
    render(<AssistantTextBlock text="普通文本" />)
    expect(screen.queryByTestId('assistant-code-refs')).toBeNull()
  })
})

describe('ReasoningBlock', () => {
  it('默认折叠，点击展开', () => {
    render(<ReasoningBlock text="thinking" />)
    expect(screen.getByTestId('reasoning').getAttribute('data-expanded')).toBe('false')
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.getByTestId('reasoning').getAttribute('data-expanded')).toBe('true')
  })

  it('折叠态展示最后一行预览', () => {
    render(<ReasoningBlock text={'第一行\n第二行\n正在思考'} />)
    expect(screen.getByTestId('reasoning-preview')).toHaveTextContent('正在思考')
  })

  it('展开后不再展示预览', () => {
    render(<ReasoningBlock text="正在思考" />)
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.queryByTestId('reasoning-preview')).toBeNull()
  })

  it('空内容时不展示预览', () => {
    render(<ReasoningBlock text="" />)
    expect(screen.queryByTestId('reasoning-preview')).toBeNull()
  })

  it('忽略末尾空行，取最后一个非空行', () => {
    render(<ReasoningBlock text={'有内容\n\n'} />)
    expect(screen.getByTestId('reasoning-preview')).toHaveTextContent('有内容')
  })
})
