import { css } from '@linaria/core'
import { Dialog } from '@/components/Dialog.js'

const bodyText = css`
  color: var(--haze-color-text-secondary);
  font-size: 13px;
  line-height: 1.5;
`

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

const actions = css`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
`

const btn = css`
  padding: 6px 12px;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg-subtle);
  color: var(--haze-color-text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;

  &:hover {
    background: var(--haze-color-bg);
  }
`

const primary = css`
  ${btn};
  border-color: var(--haze-color-primary, var(--haze-color-border));
  background: var(--haze-color-primary, var(--haze-color-bg-subtle));
  color: var(--haze-color-bg, #fff);
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
  onConfirm,
  onCancel,
}: {
  projectName: string
  items: TrustRiskItem[]
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog
      onClose={onCancel}
      title="信任此项目？"
      width="min(480px, 92vw)"
      testId="trust-required-dialog"
      footer={
        <div className={actions}>
          <button
            type="button"
            className={btn}
            onClick={onCancel}
            data-testid="trust-required-cancel"
          >
            取消
          </button>
          <button
            type="button"
            className={primary}
            onClick={onConfirm}
            data-testid="trust-required-confirm"
          >
            信任并继续
          </button>
        </div>
      }
    >
      <div className={bodyText}>
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
      <div className={bodyText}>
        信任后上述设置立即生效（项目插件需重启 serve 后加载），后续不再询问。
        请仅在确认该仓库来源可靠、且接受这些设置时信任。
      </div>
    </Dialog>
  )
}
