import { type RefObject, useEffect } from 'react'

/**
 * 把浮层里当前高亮项滚进可视区。
 *
 * 四个 composer 浮层（斜杠命令 / 子命令 / 工作流 / @ 文件）都只改 `activeIndex`，
 * 自身是 `position: absolute` + `overflow: auto` 的独立滚动容器。列表放得下时
 * 高亮变化无碍；一旦超过 max-height（命令多于 ~5 条即触发，subcommand-menu 实测
 * scrollHeight 356px / clientHeight 238px），↓ 键就会把选中项移到容器可视区之外：
 * 用户继续按 ↓，屏幕上看不出选中的是哪一条，Enter 却直接提交了看不见的那一条
 * （实测 6 次 ↓ 后 active=/workflow，activeTop 939 > menuBottom 830，scrollTop 恒为 0）。
 *
 * `block: 'nearest'` 只做最小位移：已经可见的项不会被反复顶到边缘，输入法的
 * 光标跟随与鼠标悬停不受影响。
 *
 * jsdom / happy-dom 没有 scrollIntoView，方法可能不存在——可选调用兜底，
 * 与 ModelSelector 现有写法一致。
 */
export function usePopoverScroll(
  ref: RefObject<HTMLElement | null>,
  activeIndex: number,
  open: boolean,
) {
  useEffect(() => {
    if (!open || activeIndex < 0) return
    const list = ref.current
    if (!list) return
    // [aria-selected="true"] 而非下标选择器：高亮项就是当前选中项，两者在
    // 同一渲染里同步，用语义选择器避免索引口径与列表分段（@ 菜单分 agent/文件两段）
    // 打架。
    const el = list.querySelector<HTMLElement>('[aria-selected="true"]')
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, open, ref])
}
