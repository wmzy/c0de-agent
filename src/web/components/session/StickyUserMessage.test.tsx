/**
 * StickyUserMessage 顶部滞留浮层单元测试。
 * 归并建议：本组件为独立新组件（非单 bug 补丁），暂独立成文件；后续若新增
 * session 通用交互测试可统一收口。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StickyUser } from '@/components/session/StickyUserMessage.js'
import { StickyUserMessage } from '@/components/session/StickyUserMessage.js'

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

/** rendered：只把这些 id 的消息挂进 DOM——模拟 TimelineChat 的虚拟化
 *  （窗口外的段组整体不渲染，DOM 里的 [data-role="user"] 只是消息数组的子集）。 */
function Harness({ messages, rendered }: { messages: StickyUser[]; rendered?: string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const mounted = rendered ? messages.filter((m) => rendered.includes(m.id)) : messages
  return (
    <div ref={ref}>
      <StickyUserMessage containerRef={ref} messages={messages} />
      {mounted.map((m) => (
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

  // 复现：activeIdx 是「DOM 中已渲染用户消息」的下标，却被当作 messages 全量数组的
  // 下标使用。TimelineChat 用 useVirtualizer 窗口化渲染（overscan 4），滚到中段时
  // 早期用户消息整体不在 DOM 里——浮层于是显示消息数组里第 0/1 条（会话最早的问题），
  // 与它实际滞留的元素不是同一条。
  it('虚拟化下 DOM 只渲染部分用户消息时，浮层显示滞留的那条而非数组首条', () => {
    mockRects({ u3: -50, u4: 100 })
    render(
      <Harness
        messages={[
          { id: 'u1', text: '第一问' },
          { id: 'u2', text: '第二问' },
          { id: 'u3', text: '第三问' },
          { id: 'u4', text: '第四问' },
          { id: 'u5', text: '第五问' },
        ]}
        rendered={['u3', 'u4']}
      />,
    )
    expect(screen.getByTestId('sticky-user-jump').textContent).toBe('第三问')
    // 渲染子集内 u3 之前无元素 → 上一条禁用；之后有 u4 → 下一条可用
    expect(screen.getByTestId('sticky-user-prev')).toBeDisabled()
    expect(screen.getByTestId('sticky-user-next')).toBeEnabled()
  })

  // 复现：下一条的禁用判定用 messages.length（全量），而滚动目标取 DOM 子集下标——
  // 全量长度远大于渲染数时按钮永远可用，点击后 scrollToIndex 找不到元素、静默无反应。
  it('虚拟化下活动项已是渲染子集末条时，下一条禁用', () => {
    mockRects({ u3: -50 })
    render(
      <Harness
        messages={[
          { id: 'u1', text: '第一问' },
          { id: 'u2', text: '第二问' },
          { id: 'u3', text: '第三问' },
          { id: 'u4', text: '第四问' },
          { id: 'u5', text: '第五问' },
        ]}
        rendered={['u3']}
      />,
    )
    expect(screen.getByTestId('sticky-user-jump').textContent).toBe('第三问')
    expect(screen.getByTestId('sticky-user-next')).toBeDisabled()
  })
})
