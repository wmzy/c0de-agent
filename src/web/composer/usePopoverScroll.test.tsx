// 浮层键盘高亮项的可见性。
// 回归：斜杠命令 / 子命令 / 工作流 / @ 文件四个浮层自身是 overflow:auto 的滚动容器，
// 但只改 activeIndex、不滚动容器。列表超过 max-height（命令多于 ~5 条即触发，
// 实测 subcommand-menu scrollHeight 356px / clientHeight 238px）后，↓ 会把选中项
// 移到可视区之外——用户看不出当前选中哪一条，Enter 却提交了看不见的那一条。
// 这里锁住：高亮项变化时，高亮项被滚进浮层可视区。

import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePopoverScroll } from '@/composer/usePopoverScroll.js'

afterEach(() => cleanup())

const ITEMS = Array.from({ length: 10 }, (_, i) => `item-${i}`)

/** 可控高亮项的最小浮层：10 个选项，索引由外部 props 驱动。 */
function Harness({ activeIndex, open = true }: { activeIndex: number; open?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  usePopoverScroll(ref, activeIndex, open)
  return (
    <div ref={ref} role="listbox" data-testid="menu">
      {ITEMS.map((name, i) => (
        <button key={name} type="button" role="option" aria-selected={i === activeIndex}>
          {name}
        </button>
      ))}
    </div>
  )
}

describe('usePopoverScroll', () => {
  /**
   * happy-dom 不实现滚动：spy 出「某一项被请求滚动」这一行为本身，
   * 而不是断言真实 scrollTop（测试环境里 scrollTop 恒为 0，断言它必然假通过）。
   * spy 按**选项下标**存，避免依赖节点身份，也绕开 noUncheckedIndexedAccess。
   */
  function spyAllOptions(): Map<number, ReturnType<typeof vi.fn>> {
    const menu = document.querySelector('[data-testid="menu"]') as HTMLElement
    const spies = new Map<number, ReturnType<typeof vi.fn>>()
    menu.querySelectorAll('[role="option"]').forEach((opt, i) => {
      const spy = vi.fn()
      Object.defineProperty(opt, 'scrollIntoView', { value: spy, configurable: true })
      spies.set(i, spy)
    })
    return spies
  }

  it('高亮项变化时把该项滚进可视区', () => {
    const { rerender } = render(<Harness activeIndex={0} />)
    const spies = spyAllOptions()

    rerender(<Harness activeIndex={7} />)

    expect(spies.get(7)).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('只滚动当前高亮项，其余项不动', () => {
    const { rerender } = render(<Harness activeIndex={0} />)
    const spies = spyAllOptions()

    rerender(<Harness activeIndex={3} />)

    expect(spies.get(3)).toHaveBeenCalledTimes(1)
    expect(spies.get(0)).not.toHaveBeenCalled()
    expect(spies.get(9)).not.toHaveBeenCalled()
  })

  it('浮层关闭时不滚动', () => {
    const { rerender } = render(<Harness activeIndex={0} open />)
    const menu = document.querySelector('[data-testid="menu"]') as HTMLElement
    const spy = vi.fn()
    for (const o of menu.querySelectorAll('[role="option"]')) {
      Object.defineProperty(o, 'scrollIntoView', { value: spy, configurable: true })
    }

    rerender(<Harness activeIndex={5} open={false} />)

    expect(spy).not.toHaveBeenCalled()
  })

  it('环境没有 scrollIntoView 时不抛错（happy-dom/jsdom 兜底）', () => {
    const { rerender } = render(<Harness activeIndex={0} />)
    const menu = document.querySelector('[data-testid="menu"]') as HTMLElement
    // happy-dom/jsdom 不实现滚动，必须抹掉方法验证可选调用兜底：
    // 没有兜底时这里会在 render 阶段抛 TypeError。
    for (const opt of menu.querySelectorAll('[role="option"]')) {
      Object.defineProperty(opt, 'scrollIntoView', { value: undefined, configurable: true })
    }

    expect(() => rerender(<Harness activeIndex={6} />)).not.toThrow()
  })
})
