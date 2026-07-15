import { css } from '@linaria/core'
import { Dialog } from './Dialog.js'

const bodyText = css`
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
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
    <Dialog
      onClose={onCancel}
      title="切换将开始新的上下文段"
      width="min(420px, 92vw)"
      testId="segment-break-dialog"
      footer={
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
      }
    >
      <div className={bodyText}>
        当前段使用 {activeSegment.provider}/{activeSegment.model}（{activeSegment.tools.length}{' '}
        个工具）。 切换模型或工具会使前缀失效（缓存 miss），后续调用归入新段。
      </div>
    </Dialog>
  )
}
