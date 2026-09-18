import { css } from '@linaria/core'
import { TypedLink } from '@native-router/react'
import type { AppPaths } from '@/routes.js'

const notFound = css`
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  color: var(--haze-color-text-secondary);
  font-size: 14px;
`

const code = css`
  font-size: 48px;
  font-weight: 700;
  line-height: 1;
  color: var(--haze-color-text);
  letter-spacing: 2px;
`

const backLink = css`
  margin-top: 8px;
  padding: 8px 16px;
  border: 1px solid var(--haze-color-primary);
  border-radius: 6px;
  color: var(--haze-color-primary);
  text-decoration: none;
  font-size: 13px;

  &:hover {
    background: color-mix(in srgb, var(--haze-color-primary) 10%, transparent);
  }
`

export function NotFound() {
  return (
    <div className={notFound}>
      <div className={code}>404</div>
      <div>页面不存在，地址可能已失效</div>
      <TypedLink<AppPaths> to="/" className={backLink}>
        返回会话
      </TypedLink>
    </div>
  )
}
