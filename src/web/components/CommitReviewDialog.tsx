import { css } from '@linaria/core'
import { Dialog } from './Dialog.js'

const bodyText = css`
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
`

const fileList = css`
  background: var(--bg-secondary);
  border-radius: 4px;
  font-size: 12px;
  font-family: var(--font-mono, monospace);
  color: var(--text-secondary);
  padding: 8px 12px;
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

const primaryBtn = css`
  border-color: var(--warning, var(--border));
  background: var(--warning, var(--bg-secondary));
  color: #fff;
`

/**
 * 提交前可疑文件确认弹框。LLM 检测到应忽略的文件后弹出，
 * 三选项：加入 .gitignore 再提交 / 仍然提交 / 取消。
 */
export function CommitReviewDialog({
  suggestions,
  message: _message,
  onAppendIgnore,
  onForce,
  onCancel,
}: {
  suggestions: string[]
  message: string
  onAppendIgnore: () => void
  onForce: () => void
  onCancel: () => void
}) {
  return (
    <Dialog
      onClose={onCancel}
      title="检测到可能需要忽略的文件"
      width="min(460px, 92vw)"
      testId="commit-review-dialog"
      footer={
        <div className={actions}>
          <button
            type="button"
            className={btn}
            onClick={onCancel}
            data-testid="commit-review-cancel"
          >
            取消
          </button>
          <button type="button" className={btn} onClick={onForce} data-testid="commit-review-force">
            仍然提交
          </button>
          <button
            type="button"
            className={`${btn} ${primaryBtn}`}
            onClick={onAppendIgnore}
            data-testid="commit-review-ignore"
          >
            加入 .gitignore 再提交
          </button>
        </div>
      }
    >
      <div className={bodyText}>AI 检查变更内容后认为以下文件可能应该加入 .gitignore：</div>
      <div className={fileList}>
        {suggestions.map((s) => (
          <div key={s}>{s}</div>
        ))}
      </div>
    </Dialog>
  )
}
