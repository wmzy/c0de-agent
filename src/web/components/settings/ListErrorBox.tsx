import { css } from '@linaria/core'

/**
 * 列表读取失败提示框（SecurityPanel / WorkflowsPanel / UsagePanel 共用）。
 *
 * 口径：读不到 ≠ 没有。一次 500 / 断网此前会被 `data ?? []` 说成「你一个都没有」
 * ——一个关于现状的**断言**，用户据此做错决定（认定设备/工作流/花费不存在）。
 * 失败必须渲染原因 + 重试，与「确实为空」的空态区分开。
 */

/** 行内变体（SecurityPanel / WorkflowsPanel）：危险色窄条 + 行内小重试钮。 */
const inlineBox = css`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px solid var(--haze-color-danger);
  border-radius: 6px;
  color: var(--haze-color-danger);
  font-size: 12px;
`

const inlineRetryBtn = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: var(--haze-color-bg);
  color: inherit;
  font-size: 11px;
  padding: 0 6px;
  min-height: auto;
  min-width: auto;
  cursor: pointer;

  &:disabled {
    opacity: 0.45;
    cursor: default;
  }
`

/** 块状变体（UsagePanel）：标题 + 明细行 + 独立重试按钮。 */
const stackedBox = css`
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--haze-color-danger) 45%, transparent);
  border-radius: 8px;
`

const stackedTitle = css`
  color: var(--haze-color-danger);
  font-size: 13px;
  font-weight: 600;
`

const stackedDetail = css`
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  /* 后端 message 可能是长路径/长句，窄栏内必须断行 */
  overflow-wrap: anywhere;
`

const stackedRetryBtn = css`
  align-self: flex-start;
  padding: 4px 14px;
  font-size: 12px;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  cursor: pointer;

  &:hover:not(:disabled):not([aria-disabled='true']) {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
  }
`

type ListErrorBoxProps = {
  /** 主文案：行内变体渲染成第一段正文，块状变体渲染成标题行。 */
  title: string
  /** 次要说明行，逐行渲染。 */
  lines?: string[]
  /** 行内（列表窄条，默认）或块状（面板整段失败，标题+明细分层）。 */
  variant?: 'inline' | 'stacked'
  /** 失败框 testid。 */
  testId: string
  /** 重试入口；缺省不渲染按钮。 */
  onRetry?: () => void
  /** 重试钮 testid。 */
  retryTestId?: string
  /** 重试进行中（禁用按钮）。 */
  retrying?: boolean
}

function ListErrorBox(props: ListErrorBoxProps) {
  const stacked = props.variant === 'stacked'
  const lines = props.lines ?? []
  return (
    <div className={stacked ? stackedBox : inlineBox} role="alert" data-testid={props.testId}>
      <span className={stacked ? stackedTitle : undefined}>{props.title}</span>
      {lines.map((line) => (
        <span key={line} className={stacked ? stackedDetail : undefined}>
          {line}
        </span>
      ))}
      {props.onRetry ? (
        <button
          type="button"
          className={stacked ? stackedRetryBtn : inlineRetryBtn}
          onClick={() => props.onRetry?.()}
          disabled={props.retrying}
          data-testid={props.retryTestId}
        >
          重试
        </button>
      ) : null}
    </div>
  )
}

export { ListErrorBox }
