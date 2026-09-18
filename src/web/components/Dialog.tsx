// 应用层对话框组件：对外保持 DialogProps API（footer/width/testId），
// 内部由 haze-ui 的原生 <dialog> 驱动（showModal/焦点管理/::backdrop/Esc）。
// 面板尺寸通过 --haze-dialog-width / --haze-dialog-padding 令牌注入，
// 面板与内容布局（header/footer/滚动区）沿用项目 Linaria 类。
import { css } from '@linaria/core'
import { Dialog as HazeDialog } from 'haze-ui'
import type { ReactNode } from 'react'

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
  // 与旧实现一致：关闭即卸载（调用点按条件挂载语义依赖）。
  if (!open) return null
  return (
    <div
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
