import { css } from '@linaria/core'
import { Link } from 'react-router-dom'

const notFound = css`
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 14px;
`

const code = css`
  font-size: 48px;
  font-weight: 700;
  line-height: 1;
  color: var(--text);
  letter-spacing: 2px;
`

const backLink = css`
  margin-top: 8px;
  padding: 8px 16px;
  border: 1px solid var(--primary);
  border-radius: 6px;
  color: var(--primary);
  text-decoration: none;
  font-size: 13px;

  &:hover {
    background: color-mix(in srgb, var(--primary) 10%, transparent);
  }
`

export function NotFound() {
  return (
    <div className={notFound}>
      <div className={code}>404</div>
      <div>页面不存在，地址可能已失效</div>
      <Link to="/" className={backLink}>
        返回会话
      </Link>
    </div>
  )
}
