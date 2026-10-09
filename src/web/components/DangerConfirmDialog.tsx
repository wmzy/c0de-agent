// src/web/components/DangerConfirmDialog.tsx
// P2-6：永久不可逆操作的统一确认弹层——红字说明 + 输入确认词才能启用确认按钮。
// 替代 window.confirm（原生框信息量不足、无分级确认强度，肌肉记忆易误点）。
// 软删除/可恢复操作不应使用本组件，保留轻量确认即可。

import { css } from '@linaria/core'
import { type ReactNode, useState } from 'react'
import { Dialog } from '@/components/Dialog.js'
import { SyncedInput } from '@/components/SyncedControls.js'

const desc = css`
  font-size: 13px;
  line-height: 1.6;
  color: var(--haze-color-text);
`

const dangerNote = css`
  font-size: 12px;
  color: var(--haze-color-danger);
`

/** 操作失败原因：留在弹层里，用户正在做的操作与失败原因必须同框可见。
 *  此前删除项目的失败原因被写进项目下拉（关闭即卸载），用户零反馈。 */
const errorBar = css`
  margin-top: 8px;
  padding: 6px 10px;
  border: 1px solid var(--haze-color-danger);
  border-radius: 6px;
  color: var(--haze-color-danger);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
`

const inputRow = css`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 13px;
  color: var(--haze-color-text-secondary);

  & > input {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid var(--haze-color-border);
    border-radius: 6px;
    background: var(--haze-color-bg);
    color: var(--haze-color-text);
    font-size: 13px;
    &:focus {
      outline: none;
      border-color: var(--haze-color-danger);
    }
  }
`

const btn = css`
  padding: 4px 12px;
  font-size: 13px;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  cursor: pointer;
`

/*
 * 确认按钮：红实底 + 白字。--haze-color-danger 同样是按「当文字色用」调的，
 * 当实底时白字在两个主题都不过线（实测 dark 3.76 / light 4.82，13px 文字
 * 需 4.5）——暗色下这是全应用唯一的「不可恢复」确认入口，却最难读。
 * 改用 --c0de-danger-on-solid：light 沿用白字（4.82 达标），dark 压到
 * 足够深的近黑（见 global.ts）。
 */
const dangerBtn = css`
  padding: 4px 12px;
  font-size: 13px;
  border: 1px solid var(--haze-color-danger);
  border-radius: 6px;
  background: var(--haze-color-danger);
  color: var(--c0de-danger-on-solid, #fff);
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
  /** 操作失败原因（如后端 409）。渲染在弹层正文里，role=alert 播报。 */
  error?: string | null
  /** M4：额外逃生动作（如「导出看板并删除」），渲染在取消与确认按钮之间。 */
  secondaryAction?: { label: string; onClick: () => void; busy?: boolean; disabled?: boolean }
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
  error = null,
  secondaryAction,
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
          {secondaryAction && (
            <button
              type="button"
              className={btn}
              disabled={busy || secondaryAction.busy === true || secondaryAction.disabled === true}
              onClick={secondaryAction.onClick}
              data-testid="danger-secondary-btn"
            >
              {secondaryAction.busy === true ? '处理中…' : secondaryAction.label}
            </button>
          )}
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
      {error ? (
        <div className={errorBar} role="alert" data-testid="danger-error">
          {'⚠'} {error}
        </div>
      ) : null}
      <div className={inputRow}>
        <span>输入「{confirmWord}」以确认：</span>
        <SyncedInput
          value={typed}
          onChange={(v) => setTyped(v)}
          placeholder={confirmWord}
          data-testid="danger-confirm-input"
        />
      </div>
    </Dialog>
  )
}
