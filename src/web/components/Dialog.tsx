// 应用层对话框组件：对外保持 DialogProps API（footer/width/testId），
// 内部由 haze-ui 的原生 <dialog> 驱动（showModal/焦点管理/::backdrop/Esc）。
// 面板尺寸通过 --haze-dialog-width / --haze-dialog-padding 令牌注入，
// 面板与内容布局（header/footer/滚动区）沿用项目 Linaria 类。
import { css } from '@linaria/core'
import { Dialog as HazeDialog } from 'haze-ui'
import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'

export type DialogProps = {
  open?: boolean
  onClose: () => void
  title?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  width?: string
  testId?: string
}

/** 面板：全高列布局，内部滚动；外框圆角/阴影/边框由 haze 面板样式提供。 */
const panel = css`
  position: relative;
  display: flex;
  flex-direction: column;
  max-height: 85dvh;
  overflow: hidden;
`

/** 标题行：h2 槽位类（haze classNames.header）。 */
const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 44px 16px 20px;
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 15px;
  font-weight: 600;
`

/** 关闭按钮：绝对定位在面板右上角，与标题行对齐。 */
const closeButton = css`
  position: absolute;
  top: 10px;
  right: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--haze-color-text-secondary);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;

  &:hover {
    background: var(--haze-color-bg-subtle);
    color: var(--haze-color-text);
  }
`

const content = css`
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  padding: 16px 20px;
`

const footerBar = css`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--haze-color-border);
`

export function Dialog({
  open = true,
  onClose,
  title,
  children,
  footer,
  width,
  testId,
}: DialogProps) {
  const panelWrapRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  // 面板节点自持一份：ref 在卸载的 mutation 阶段就被置空，那时
  // panelWrapRef.current 已是 null，判定「焦点是否还在面板上」会一律失败。
  const panelElRef = useRef<HTMLElement | null>(null)
  // 关闭后把焦点还给触发元素。原生 <dialog> 打开即把焦点收进面板，而 Esc 被
  // haze 的 onCancel preventDefault 掉走受控关闭，浏览器那套「close 时
  // 归还到 showModal 前的焦点」永不触发；面板卸载后焦点落到 <body>——键盘
  // 用户位置丢失，下次 Tab 从页首重来，读屏也失去上下文。open 变 false 与整体
  // 卸载两条路径都收敛到同一处归还。
  //
  // 捕获必须在 layout 阶段：haze 面板的 showModal 走的是 passive effect，
  // 子树先于父树执行，等本组件的 effect 跑时焦点已被它挪进面板。
  useLayoutEffect(() => {
    if (!open) return
    panelElRef.current = panelWrapRef.current
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return
    // StrictMode 的双挂载重放会再跑一次本 effect，此时焦点已在面板内——重复
    // 捕获会把面板内元素当成触发元素，关闭时聚焦一个已卸载的节点。
    if (panelWrapRef.current?.contains(active)) return
    triggerRef.current = active
  }, [open])

  // 归还在 passive 阶段：卸载的 layout cleanup 跑在 DOM 摘除之前，弹层仍是
  // modal 时触发元素处于 inert，focus() 会被浏览器丢弃。
  useEffect(() => {
    if (!open) return
    return () => {
      const panel = panelElRef.current
      // StrictMode 双挂载重放：面板仍在文档中，弹层根本没关。此时既不归还也
      // 不清空触发元素——重放后的 setup 还要用它，否则真正关闭时无处可还。
      if (panel?.isConnected) return
      const el = triggerRef.current
      triggerRef.current = null
      panelElRef.current = null
      // 触发元素已随本次关闭被删（如触发它的按钮本身在条件渲染里）：对它
      // focus() 是空操作，白调一次还挡掉了后续正确归还。
      if (!el?.isConnected) return
      // 焦点仍落在面板内（尚未随节点摘除而清空）时同样要归还；只有真的被别处
      // 接管（调用方 close 后主动聚焦别处）时才让路。
      const cur = document.activeElement
      if (cur && cur !== document.body && !panel?.contains(cur)) return
      el.focus()
    }
  }, [open])

  // 与旧实现一致：关闭即卸载（调用点按条件挂载语义依赖）。
  if (!open) return null
  return (
    <div
      ref={panelWrapRef}
      style={
        {
          '--haze-dialog-width': width ?? '480px',
          '--haze-dialog-padding': '0',
        } as React.CSSProperties
      }
    >
      <HazeDialog open onClose={onClose} title={title} classNames={{ root: panel, header }}>
        {title != null && (
          <button type="button" className={closeButton} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        )}
        {children != null && (
          <div className={content} data-testid={testId}>
            {children}
          </div>
        )}
        {footer != null && <div className={footerBar}>{footer}</div>}
      </HazeDialog>
    </div>
  )
}
