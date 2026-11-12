import { useEffect, useRef } from 'react'

/** 条件挂载的 document 级 Esc 监听：enabled 时挂载、关闭即卸载。
 *  「Esc 关闭顶层模态」的口径单一实现——App 的配对横幅与 PairingView 的
 *  审批弹层此前各持一份手写监听（App 注释自称「与 PairingApproval 同口径」，
 *  第三处复制时就该收敛了）。回调存 ref：enabled 不变时回调身份变化不重建
 *  监听，调用方可直接传每次渲染新建的闭包。 */
export function useEscapeOnDocument(enabled: boolean, onEscape: () => void): void {
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscapeRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [enabled])
}
