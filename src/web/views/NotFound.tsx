import { css } from '@linaria/core'

const notFound = css`
  padding: 24px;
`

export function NotFound() {
  return <div className={notFound}>404 — 页面不存在</div>
}
