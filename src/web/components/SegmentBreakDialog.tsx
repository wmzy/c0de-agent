import { css } from '@linaria/core'

const overlay = css`
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 50%);
`

const card = css`
  min-width: 320px;
  max-width: 420px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  box-shadow: 0 8px 24px rgb(0 0 0 / 20%);
`

const title = css`
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 8px;
`

const body = css`
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
  margin-bottom: 12px;
`

const actions = css`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
`

const btn = css`
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;

  &:hover {
    background: var(--bg);
  }
`

const primary = css`
  ${btn};
  border-color: var(--accent, var(--border));
  background: var(--accent, var(--bg-secondary));
  color: var(--bg, #fff);
`

/**
 * 段切换确认弹窗：切换 provider/model/tools 将使前缀失效、开新上下文段（缓存 miss），
 * 需用户确认。三选项：继续（仅开新段）/ 顺便压缩会话（压缩后再开新段）/ 取消（还原选择）。
 */
export function SegmentBreakDialog({
  activeSegment,
  onConfirm,
  onCompact,
  onCancel,
}: {
  activeSegment: { provider: string; model: string; tools: string[] }
  onConfirm: () => void
  onCompact: () => void
  onCancel: () => void
}) {
  return (
    <div className={overlay} data-testid="segment-break-dialog" role="dialog" aria-modal="true">
      <div className={card}>
        <div className={title}>切换将开始新的上下文段</div>
        <div className={body}>
          当前段使用 {activeSegment.provider}/{activeSegment.model}（{activeSegment.tools.length}{' '}
          个工具）。 切换模型或工具会使前缀失效（缓存 miss），后续调用归入新段。
        </div>
        <div className={actions}>
          <button
            type="button"
            className={btn}
            onClick={onCancel}
            data-testid="segment-break-cancel"
          >
            取消
          </button>
          <button
            type="button"
            className={btn}
            onClick={onCompact}
            data-testid="segment-break-compact"
          >
            顺便压缩会话
          </button>
          <button
            type="button"
            className={primary}
            onClick={onConfirm}
            data-testid="segment-break-confirm"
          >
            继续
          </button>
        </div>
      </div>
    </div>
  )
}
