// src/web/components/DangerConfirmDialog.tsx
// P2-6：永久不可逆操作的统一确认弹层——红字说明 + 输入确认词才能启用确认按钮。
// 替代 window.confirm（原生框信息量不足、无分级确认强度，肌肉记忆易误点）。
// 软删除/可恢复操作不应使用本组件，保留轻量确认即可。

import { css } from '@linaria/core'
import { type ReactNode, useState } from 'react'
import { Dialog } from './Dialog.js'

const desc = css`
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
`

const dangerNote = css`
  font-size: 12px;
  color: var(--error);
`

const inputRow = css`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 13px;
  color: var(--text-secondary);

  & > input {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    &:focus {
      outline: none;
      border-color: var(--error);
    }
  }
`

const btn = css`
  padding: 4px 12px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
`

const dangerBtn = css`
  padding: 4px 12px;
  font-size: 13px;
  border: 1px solid var(--error);
  border-radius: 6px;
  background: var(--error);
  color: #fff;
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`

type DangerConfirmDialogProps = {
  open: boolean
  title: string
  description: ReactNode
  /** 用户必须逐字输入该词才能启用确认按钮（通常为项目名/会话标题）。 */
  confirmWord: string
  confirmLabel?: string
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}

export function DangerConfirmDialog({
  open,
  title,
  description,
  confirmWord,
  confirmLabel = '确认删除',
  busy = false,
  onConfirm,
  onClose,
}: DangerConfirmDialogProps) {
  const [typed, setTyped] = useState('')
  const matched = typed === confirmWord
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      testId="danger-confirm-dialog"
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={dangerBtn}
            disabled={!matched || busy}
            onClick={onConfirm}
            data-testid="danger-confirm-btn"
          >
            {busy ? '执行中…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className={desc}>{description}</div>
      <div className={dangerNote}>此操作不可恢复。</div>
      <div className={inputRow}>
        <span>输入「{confirmWord}」以确认：</span>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={confirmWord}
          autoFocus
          data-testid="danger-confirm-input"
        />
      </div>
    </Dialog>
  )
}
