/**
 * StickyUserMessage 顶部滞留浮层单元测试。
 * 归并建议：本组件为独立新组件（非单 bug 补丁），暂独立成文件；后续若新增
 * session 通用交互测试可统一收口。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StickyUser } from './StickyUserMessage.js'
import { StickyUserMessage } from './StickyUserMessage.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function domRect(top: number): DOMRect {
  return {
    top,
    bottom: top,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => {},
  } as DOMRect
}

/** mock getBoundingClientRect：[data-role="user"] 按 msgId 映射 top，其余（含滚动容器）返回 containerTop。 */
function mockRects(rectByMsgId: Record<string, number>, containerTop = 0) {
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.dataset?.role === 'user') {
      return domRect(rectByMsgId[this.dataset.msgId ?? ''] ?? 0)
    }
    return domRect(containerTop)
  })
}

function Harness({ messages }: { messages: StickyUser[] }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref}>
      <StickyUserMessage containerRef={ref} messages={messages} />
      {messages.map((m) => (
        <div data-role="user" data-msg-id={m.id} key={m.id}>
          {m.text}
        </div>
      ))}
    </div>
  )
}

describe('StickyUserMessage', () => {
  it('无用户消息时仅渲染占位容器，不显示浮层', () => {
    mockRects({})
    render(<Harness messages={[]} />)
    expect(screen.getByTestId('sticky-user-placeholder')).toBeInTheDocument()
    expect(screen.queryByTestId('sticky-user')).toBeNull()
  })

  it('首条用户消息未进入顶部浮层区时不滞留', () => {
    // top 100 > 阈值(STICKY_H+1=37) → 消息完全可见于浮层下方，不滞留
    mockRects({ u1: 100 })
    render(<Harness messages={[{ id: 'u1', text: '你好' }]} />)
    expect(screen.queryByTestId('sticky-user')).toBeNull()
  })

  it('用户消息越过阈值后浮层显示该消息文本', () => {
    mockRects({ u1: -50, u2: 100 })
    render(
      <Harness
        messages={[
          { id: 'u1', text: '第一问' },
          { id: 'u2', text: '第二问' },
        ]}
      />,
    )
    expect(screen.getByTestId('sticky-user')).toBeInTheDocument()
    expect(screen.getByTestId('sticky-user-jump').textContent).toBe('第一问')
    expect(screen.getByTestId('sticky-user-prev')).toBeDisabled()
    expect(screen.getByTestId('sticky-user-next')).toBeEnabled()
  })

  it('末条用户消息滞留时下一条按钮禁用、上一条可用', () => {
    mockRects({ u1: -200, u2: -50 })
    render(
      <Harness
        messages={[
          { id: 'u1', text: '第一问' },
          { id: 'u2', text: '第二问' },
        ]}
      />,
    )
    expect(screen.getByTestId('sticky-user-jump').textContent).toBe('第二问')
    expect(screen.getByTestId('sticky-user-prev')).toBeEnabled()
    expect(screen.getByTestId('sticky-user-next')).toBeDisabled()
  })

  it('点击文本区滚动到该消息并对齐浮层下方', () => {
    mockRects({ u1: -50, u2: 100 })
    const scrollBy = vi.spyOn(HTMLElement.prototype, 'scrollBy').mockImplementation(() => {})
    render(
      <Harness
        messages={[
          { id: 'u1', text: '第一问' },
          { id: 'u2', text: '第二问' },
        ]}
      />,
    )
    fireEvent.click(screen.getByTestId('sticky-user-jump'))
    // top = eRect.top(-50) - cRect.top(0) - STICKY_H(36) = -86
    expect(scrollBy).toHaveBeenCalledWith({ top: -86, behavior: 'smooth' })
  })

  it('点击下一条箭头滚动到下一条用户消息', () => {
    mockRects({ u1: -50, u2: 100 })
    const scrollBy = vi.spyOn(HTMLElement.prototype, 'scrollBy').mockImplementation(() => {})
    render(
      <Harness
        messages={[
          { id: 'u1', text: '第一问' },
          { id: 'u2', text: '第二问' },
        ]}
      />,
    )
    fireEvent.click(screen.getByTestId('sticky-user-next'))
    // 目标 u2：top 100 - 0 - 36 = 64
    expect(scrollBy).toHaveBeenCalledWith({ top: 64, behavior: 'smooth' })
  })
})
