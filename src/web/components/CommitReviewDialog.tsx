import { css } from '@linaria/core'
import { CopyButton } from '@/components/CopyButton.js'
import { Dialog } from '@/components/Dialog.js'

const bodyText = css`
  color: var(--haze-color-text-secondary);
  font-size: 13px;
  line-height: 1.5;
`

const fileList = css`
  background: var(--haze-color-bg-subtle);
  border-radius: 4px;
  font-size: 12px;
  font-family: var(--haze-font-mono, monospace);
  color: var(--haze-color-text-secondary);
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

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`

const primaryBtn = css`
  border-color: var(--haze-color-warning, var(--haze-color-border));
  background: var(--haze-color-warning, var(--haze-color-bg-subtle));
  /* 琥珀实底上的前景色走 token：warning 的 dark 值是琥珀**字**色，
     当底色时白字仅 1.67:1（全应用最差的一处）。见 global.ts 的说明。 */
  color: var(--c0de-warning-on-solid, #fff);
`

const sectionLabel = css`
  font-size: 12px;
  color: var(--haze-color-text-secondary);
  margin-bottom: 4px;
`

/** commit message 原样呈现（保留换行与缩进）：这是要被审阅的提交内容本身，
 *  压成一行摘要等于把「审阅」降级成「扫一眼标签」。 */
const messageBox = css`
  background: var(--haze-color-bg-subtle);
  border-radius: 4px;
  border: 1px solid var(--haze-color-border);
  padding: 8px 12px;
  margin: 0;
  font-family: var(--haze-font-mono, monospace);
  font-size: 12px;
  line-height: 1.5;
  color: var(--haze-color-text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 30vh;
  overflow-y: auto;
`

const messageBoxWrap = css`
  margin-bottom: 12px;
`

const messageActions = css`
  display: flex;
  justify-content: flex-end;
  padding-top: 2px;
`

const errorBar = css`
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--haze-color-danger);
  border-radius: 6px;
  background: var(--haze-color-danger-bg, transparent);
  color: var(--haze-color-danger);
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
`

/**
 * 提交前可疑文件确认弹框。LLM 检测到应忽略的文件后弹出，
 * 三选项：加入 .gitignore 再提交 / 仍然提交 / 取消。
 */
export function CommitReviewDialog({
  suggestions,
  message,
  busy = false,
  error = null,
  onAppendIgnore,
  onForce,
  onCancel,
}: {
  suggestions: string[]
  /** 这次提交将写入的 commit message。必须渲染在弹框里：三个按钮里有两个
   *  会真的落库（force / append-ignore），用户却只能看到可疑文件清单——
   * 提交历史里出现一条自己没审过的 message，事后无从发现。 */
  message: string
  /** 提交请求在飞：三颗按钮禁用，弹层不给关闭出口（防止重复 commit / 丢掉失败原因）。 */
  busy?: boolean
  /** 提交失败原因。渲染在弹层正文里（role=alert），因为顶栏那行反馈被模态遮住。 */
  error?: string | null
  onAppendIgnore: () => void
  onForce: () => void
  onCancel: () => void
}) {
  // 请求在飞时不给关闭出口：Esc / 点背景 / ✕ / 取消都走这里。失败原因只渲染在
  // 这块面板里，中途关掉它就等于把失败原因一起关掉。
  const dismiss = () => {
    if (busy) return
    onCancel()
  }
  return (
    <Dialog
      onClose={dismiss}
      closeDisabled={busy}
      title="检测到可能需要忽略的文件"
      width="min(460px, 92vw)"
      testId="commit-review-dialog"
      footer={
        <div className={actions}>
          <button
            type="button"
            className={btn}
            onClick={dismiss}
            disabled={busy}
            data-testid="commit-review-cancel"
          >
            取消
          </button>
          <button
            type="button"
            className={btn}
            onClick={onForce}
            disabled={busy}
            data-testid="commit-review-force"
          >
            仍然提交
          </button>
          <button
            type="button"
            className={`${btn} ${primaryBtn}`}
            onClick={onAppendIgnore}
            disabled={busy}
            data-testid="commit-review-ignore"
          >
            加入 .gitignore 再提交
          </button>
        </div>
      }
    >
      {/* 提交内容先于「可疑文件」呈现：这是一个审阅动作，用户要判的是
          「这条 message 我认不认」，可疑文件清单只是佐证。message 为空
          （服务端没给）时不画空框，只提示缺失。 */}
      <div className={sectionLabel}>将要写入的 commit message</div>
      {message ? (
        <div className={messageBoxWrap}>
          <pre className={messageBox} data-testid="commit-review-message">
            {message}
          </pre>
          <div className={messageActions}>
            <CopyButton text={message} label="复制 message" />
          </div>
        </div>
      ) : (
        <div className={bodyText} data-testid="commit-review-message-empty">
          未生成 commit message（提交后会由 Git 生成一条默认信息）。
        </div>
      )}
      <div className={bodyText}>AI 检查变更内容后认为以下文件可能应该加入 .gitignore：</div>
      <div className={fileList}>
        {suggestions.map((s) => (
          <div key={s}>{s}</div>
        ))}
      </div>
      {error ? (
        <div className={errorBar} role="alert" data-testid="commit-review-error">
          {'⚠'} {error}
        </div>
      ) : null}
    </Dialog>
  )
}
