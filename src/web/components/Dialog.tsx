import { css } from '@linaria/core'
import { type ReactNode, useEffect } from 'react'

export type DialogProps = {
  open?: boolean
  onClose: () => void
  title?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  width?: string
  testId?: string
}

const overlay = css`
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
`

const container = css`
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
  max-height: 85vh;
  max-width: 92vw;
  width: min(480px, 92vw);
`

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
`

const titleText = css`
  font-size: 15px;
  font-weight: 600;
`

const closeButton = css`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--text-secondary);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;

  &:hover {
    background: var(--bg-secondary);
    color: var(--text);
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
  padding: 12px 20px;
  border-top: 1px solid var(--border);
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
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className={overlay}
      role="dialog"
      aria-modal="true"
      data-testid={testId}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={container} style={width ? { width } : undefined}>
        {title != null && (
          <div className={header}>
            <div className={titleText}>{title}</div>
            <button type="button" className={closeButton} onClick={onClose} aria-label="关闭">
              ✕
            </button>
          </div>
        )}
        {children != null && <div className={content}>{children}</div>}
        {footer != null && <div className={footerBar}>{footer}</div>}
      </div>
    </div>
  )
}
