import { css } from '@linaria/core'
import { useOverflow } from './hooks/useOverflow.js'

const wrap = css`
  display: flex;
  flex-direction: column;
  /* 用户消息轻底色气泡：与无背景的 assistant 文本形成角色区分，
     底色用 --bg-secondary，明暗主题下均与消息流底色有可感知差异 */
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--bg-secondary);
`

const text = css`
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.5;
`

const collapsed = css`
  max-height: 300px;
  overflow: hidden;
`

const btn = css`
  align-self: flex-start;
  font-size: 12px;
  color: var(--primary);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 2px 0;
`

export function UserTextBlock({ text: content }: { text: string }) {
  const { ref, overflowing, expanded, toggle } = useOverflow()
  const showToggle = overflowing && !expanded
  return (
    <div className={wrap} data-testid="user-text">
      <div ref={ref} className={showToggle ? collapsed : ''}>
        <pre className={text}>{content}</pre>
      </div>
      {overflowing && (
        <button type="button" className={btn} onClick={toggle}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  )
}
