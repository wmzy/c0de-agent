import { css } from '@linaria/core'
import { type ReactNode, useEffect, useRef, useState } from 'react'

const wrap = css`
  position: relative;
  display: inline-flex;
`

const panel = css`
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 160px;
  max-width: 320px;
  max-height: 360px;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow, 0 4px 12px rgba(0, 0, 0, 0.15));
  z-index: 100;
  padding: 4px 0;
`

const footerSlot = css`
  border-top: 1px solid var(--border);
  margin-top: 2px;
  padding-top: 2px;
`

/**
 * 轻量下拉菜单：trigger 点击展开 panel，点击外部/Escape 关闭。
 * panel 内容由 children 决定，footer 为底部操作区（如"添加"按钮）。
 */
export function DropdownMenu({
  trigger,
  children,
  footer,
  align = 'left',
  testId,
  onOpenChange,
}: {
  trigger: ReactNode
  children: (close: () => void) => ReactNode
  footer?: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  testId?: string
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const close = () => setOpen(false)

  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])

  return (
    <div className={wrap} ref={ref} data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid={testId ? `${testId}-trigger` : undefined}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          font: 'inherit',
          color: 'inherit',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '2px',
        }}
      >
        {trigger}
      </button>
      {open && (
        <div
          className={panel}
          style={align === 'right' ? { left: 'auto', right: 0 } : undefined}
          data-testid={testId ? `${testId}-panel` : undefined}
        >
          {children(close)}
          {footer && <div className={footerSlot}>{footer(close)}</div>}
        </div>
      )}
    </div>
  )
}
