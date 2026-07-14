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
  min-width: 340px;
  max-width: 460px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  box-shadow: 0 8px 24px rgb(0 0 0 / 20%);
`

const titleStyle = css`
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 8px;
`

const bodyText = css`
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
  margin-bottom: 12px;
`

const fileList = css`
  margin: 4px 0 12px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-radius: 4px;
  font-size: 12px;
  font-family: var(--font-mono, monospace);
  color: var(--text-secondary);
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
    <div className={overlay} data-testid="commit-review-dialog" role="dialog" aria-modal="true">
      <div className={card}>
        <div className={titleStyle}>检测到可能需要忽略的文件</div>
        <div className={bodyText}>AI 检查变更内容后认为以下文件可能应该加入 .gitignore：</div>
        <div className={fileList}>
          {suggestions.map((s) => (
            <div key={s}>{s}</div>
          ))}
        </div>
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
      </div>
    </div>
  )
}
