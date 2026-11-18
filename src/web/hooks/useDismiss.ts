import { type RefObject, useEffect, useRef } from 'react'
import { useEscapeOnDocument } from '@/hooks/useEscapeOnDocument.js'

/**
 * 点击 ref 外部 / 按 Escape 关闭浮层（仅 open 时挂 document 监听，关闭即卸载）。
 * ToolToggle / ModelSelector / DirectoryPicker 的弹出层关闭此前三处各持一份手写，
 * 且已现漂移：DirectoryPicker 那份条件反转——空依赖常挂 mousedown（建议未展开也
 * 在监听）、且没有 Escape 路径。
 *
 * escapeFocusRef：Esc 关闭后焦点的去处（通常是触发按钮）。浮层随关闭卸载时焦点
 * 会掉回 body，下一次 Tab 从文档头重来；不传则不挪焦点（焦点宿主不随浮层卸载的
 * 组件——如焦点本就在输入框上的建议列表——无需归还）。
 *
 * Esc 路径委托 useEscapeOnDocument（「Esc 关闭」口径单一实现，回调 ref 化）；
 * mousedown 路径同样把 onClose 存 ref：open 不变期间 onClose 身份变化（消费方
 * 每次渲染新建闭包是常态）不再反复卸挂监听，事件触发时取到的始终是最新回调。
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
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [ref, open])

  useEscapeOnDocument(open, () => {
    onClose()
    escapeFocusRef?.current?.focus()
  })
}
