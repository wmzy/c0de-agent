import { css } from '@linaria/core'
import {
  confirmActions,
  confirmBodyText,
  confirmBtn,
  confirmPrimaryBtn,
} from '@/components/confirmDialogStyles.js'
import { Dialog, useDialogDismiss } from '@/components/Dialog.js'
import { DialogInlineError } from '@/components/DialogInlineError.js'

const riskList = css`
  margin: 10px 0 0;
  padding: 8px 12px;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg-subtle);
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
`

const riskItem = css`
  display: flex;
  gap: 8px;
  align-items: baseline;
`

export type TrustRiskItem = { kind: string; detail: string }

/**
 * P0-2 项目信任确认弹窗：项目作用域配置（.c0de/config.json）含风险项
 * （auto 权限 / timeoutAction=deny 降级 / 启用项目插件）且项目尚未被信任时，
 * 后端 409 拦截并由本弹窗明示。
 * 「信任并继续」→ POST /api/projects/:id/trust（一次性）→ 原消息重发；
 * 「取消」→ 移除本次乐观消息，不发送。
 */
export function TrustRequiredDialog({
  projectName,
  items,
  error,
  busy = false,
  onConfirm,
  onCancel,
}: {
  projectName: string
  items: TrustRiskItem[]
  /** 上次信任请求失败的原因。渲染在弹窗**内部**：本弹窗是 <dialog> 模态，
   *  把原因写在会话区的横幅上会被 ::backdrop 遮住，用户只看到「点了没反应」。 */
  error?: string | null
  /** 信任请求在飞：禁用「信任并继续」并禁止关闭，避免连点重复发请求。 */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  // busy 在飞时不给关闭出口（closeDisabled + 按钮 disabled 之外的行为兜底），
  // 避免连点重复发请求。
  const dismiss = useDialogDismiss(onCancel, busy)
  return (
    <Dialog
      onClose={dismiss}
      closeDisabled={busy}
      title="信任此项目？"
      width="min(480px, 92vw)"
      testId="trust-required-dialog"
      footer={
        <div className={confirmActions}>
          <button
            type="button"
            className={confirmBtn}
            onClick={dismiss}
            disabled={busy}
            data-testid="trust-required-cancel"
          >
            取消
          </button>
          <button
            type="button"
            className={confirmPrimaryBtn}
            onClick={onConfirm}
            disabled={busy}
            data-testid="trust-required-confirm"
          >
            {busy ? '信任中…' : '信任并继续'}
          </button>
        </div>
      }
    >
      <div className={confirmBodyText}>
        项目「{projectName}」的项目配置文件（<code>.c0de/config.json</code>）包含以下设置。
        这些设置来自项目仓库本身，可能随他人提交的代码一起进入你的机器：
      </div>
      <div className={riskList}>
        {items.map((item) => (
          <div className={riskItem} key={item.kind}>
            <span aria-hidden="true">⚠</span>
            <span>{item.detail}</span>
          </div>
        ))}
      </div>
      <div className={confirmBodyText}>
        信任后上述设置立即生效（项目插件需重启 serve 后加载），后续不再询问。
        请仅在确认该仓库来源可靠、且接受这些设置时信任。
      </div>
      {error ? <DialogInlineError testId="trust-required-error">{error}</DialogInlineError> : null}
    </Dialog>
  )
}
