import { css } from '@linaria/core'
import { ApprovalCard } from 'haze-ui'
import { useEffect, useRef, useState } from 'react'

/** 外层 dock 条：保留与原 composer 底栏一致的贴顶分隔。 */
const dock = css`
  padding: 8px 12px;
  border-top: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg-subtle);
  font-size: 13px;
`

/** 工具入参预览：等宽小字、限高滚动。 */
const inputPreview = css`
  margin: 0;
  max-height: 80px;
  overflow: auto;
  font-size: 11px;
  opacity: 0.8;
  white-space: pre-wrap;
  word-break: break-word;
`

const allowAlways = css`
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  white-space: nowrap;
  & input {
    min-height: auto;
    min-width: auto;
    margin: 0;
  }
`

type Props = {
  tool: string
  input: unknown
  /** 允许「本会话始终允许」勾选（仅会话级 dock；全局/草稿页不提供）。 */
  allowAlways?: boolean
  onConfirm: (alwaysAllow: boolean) => void
  onCancel: () => void
}

/**
 * 权限确认 dock：工具执行前的人审入口。
 * 以 ApprovalCard 承载（警告色表头 + 主色「允许」/描边「拒绝」），
 * 比原先低调的文本条更醒目——权限放行是安全关键操作，视觉层级应最高。
 *
 * 「请求到达」本身是需要用户介入的状态变化（run 就停在这一步等确认），
 * 因此按 alertdialog 处理：挂载即把焦点移到 dock 容器（读屏播报标题与
 * 工具入参），Tab 先落到「拒绝」再落到「允许」，Esc 等价拒绝；关闭后把
 * 焦点还给来时的输入框。此前该 dock 是无 role 的普通 div——到达时焦点仍
 * 在输入框、页面无任何 live region，读屏用户只能自己 Tab 一圈才发现
 * agent 被阻塞；Esc 也不通，只能精确点到按钮。
 */
function PermissionDock(props: Props) {
  const [alwaysAllow, setAlwaysAllow] = useState(false)
  const dockRef = useRef<HTMLDivElement>(null)
  const titleId = 'permission-dock-title'
  const inputId = 'permission-dock-input'

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dockRef.current?.focus()
    // 关闭后焦点落回输入框——否则停在已卸载的节点上，后续 Tab 从文档开头重来。
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  return (
    <div
      ref={dockRef}
      className={dock}
      data-testid="permission-dock"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={inputId}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          props.onCancel()
        }
      }}
    >
      <ApprovalCard
        title={
          <span id={titleId}>
            工具 <strong>{props.tool}</strong> 请求执行
          </span>
        }
        onApprove={() => props.onConfirm(alwaysAllow)}
        onDeny={props.onCancel}
        approveText="允许"
        denyText="拒绝"
      >
        <pre className={inputPreview} id={inputId}>
          {JSON.stringify(props.input, null, 2)}
        </pre>
        {props.allowAlways && (
          <label className={allowAlways}>
            <input
              type="checkbox"
              checked={alwaysAllow}
              onChange={(e) => setAlwaysAllow(e.target.checked)}
            />
            本会话始终允许该工具
          </label>
        )}
      </ApprovalCard>
    </div>
  )
}

export { PermissionDock }
