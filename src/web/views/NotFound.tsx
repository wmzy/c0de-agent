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
  /* 升级为 h1 后收回浏览器默认 margin，保持原有居中排版 */
  margin: 0;
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
      {/* 404 页没有侧栏也没有任何标题元素，是全应用唯一「一个标题都没有」的
       *  页面；把错误码本身作为 h1，读屏用户一进来就知道这是错误页。 */}
      <h1 className={code}>404</h1>
      <div>页面不存在，地址可能已失效</div>
      <TypedLink<AppPaths> to="/" className={backLink}>
        返回会话
      </TypedLink>
    </div>
  )
}
