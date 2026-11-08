import { type RefObject, useEffect } from 'react'

/**
 * 点击 ref 外部 / 按 Escape 关闭浮层（仅 open 时挂 document 监听，关闭即卸载）。
 * ToolToggle / ModelSelector / DirectoryPicker 的弹出层关闭此前三处各持一份手写，
 * 且已现漂移：DirectoryPicker 那份条件反转——空依赖常挂 mousedown（建议未展开也
 * 在监听）、且没有 Escape 路径。
 *
 * escapeFocusRef：Esc 关闭后焦点的去处（通常是触发按钮）。浮层随关闭卸载时焦点
 * 会掉回 body，下一次 Tab 从文档头重来；不传则不挪焦点（焦点宿主不随浮层卸载的
 * 组件——如焦点本就在输入框上的建议列表——无需归还）。
 */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  {
    open,
    onClose,
    escapeFocusRef,
  }: {
    open: boolean
    onClose: () => void
    escapeFocusRef?: RefObject<HTMLElement | null>
  },
): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      onClose()
      escapeFocusRef?.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [ref, open, onClose, escapeFocusRef])
}
